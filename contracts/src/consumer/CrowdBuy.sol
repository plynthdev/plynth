// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {SavingsVault} from "./SavingsVault.sol";
import {StockRouter} from "../core/StockRouter.sol";
import {Valuer} from "../core/Valuer.sol";
import {StockTokenRegistry} from "../core/StockTokenRegistry.sol";
import {KeyChecks} from "../libs/KeyChecks.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";
import {StealthClaims} from "./StealthClaims.sol";

/// The part of ShieldedPool (todo 16) Hidden delivery uses.
interface IShieldedDeposit {
    function crowd() external view returns (address);
    function depositFor(
        address asset,
        uint256 raw,
        bytes32 ownerPk,
        bytes32 blinding,
        bytes calldata encryptedNote,
        address origin
    ) external returns (uint256 pendingId);
}

interface IExecuteBeacon {
    function executeAfter(bytes32 key) external view returns (uint64);
    function GRACE() external view returns (uint64);
}

/// Pools many small USDG buys of one Stock Token into one swap.
///
/// Each asset has one open "book". `join` sweeps a saver's pending USDG out of the SavingsVault and splits
/// it by the saver's mix into each asset's open book. A book executes (one router swap for its whole USDG
/// total) once it has at least MIN_CROWD distinct accounts AND the current 24h window's jittered beacon time
/// has passed. If the crowd is too small when a window ends nothing happens: the same book simply stays open
/// into the next window. At most one execution per asset per window. No per-user loops anywhere.
///
/// Allocation proof: there is no Merkle tree because everything is computable on-chain. A user's order is
/// the sum of their `Joined` events for (asset, bookId) minus a `Cancelled` event; the book total, raw tokens
/// out, account count and oracle round are in `Executed`; `allocationOf(asset, bookId, user)` returns
/// floor(rawOut * order / usdgTotal) in raw token units. Anyone can recompute it from logs and compare.
///
/// Units: allocations are raw Stock Token base units and are never scaled by `uiMultiplier`, so a
/// multiplier change (split, dividend) after execution cannot change anyone's allocation.
/// Dust (rawOut minus the sum of floored allocations) stays here; it is added to `dust[asset]` when the
/// last account of a book has settled (claimed or delivered), so `dust` is exact, never an estimate.
///
/// Exit: `claimOpen` is never gated by the user's delivery mode, the keeper or the owner. A Quiet/Hidden
/// user who claims openly receives tokens at their own address (a documented privacy cost).
/// Quiet delivery (todo 09) is two keeper steps in separate transactions so no single transaction names both
/// a user and a stealth address: `deliver` settles a Quiet user's allocation into StealthClaims' unassigned
/// pool (names the user, like the public funding), and `deliverStealth` assigns pool tokens to one fresh
/// ERC-5564 stealth address and announces it (names only the stealth address). The keeper splits each
/// allocation into parts across later executions, so amounts and timing do not line up one to one.
/// Trust: the owner can only rotate the keeper and set StealthClaims once. The keeper can only settle users
/// who chose Quiet (vault mode 1) AND registered an ERC-6538 meta-address, and can only assign pooled tokens
/// to stealth addresses. Stealth addresses cannot be checked on-chain, so Quiet users trust the keeper to
/// derive them from their meta-address (a wrong one is visible to the user's scan as a missing balance).
/// Hidden delivery (todo 16): `deliver` with route abi.encode(uint8 2, bytes32 blinding, bytes encryptedNote)
/// settles a Hidden user's allocation straight into ShieldedPool.depositFor as one pending note owned by the
/// ownerPk the USER registered in the vault (the keeper picks only the blinding and the encrypted copy). The
/// user is the deposit's origin, so a note the user cannot open (bad encryption) can be refunded to them
/// while it is pending.
/// Nobody can move pooled USDG anywhere except into the router for that book or back to the vault on cancel.
///
/// MIN_CROWD and sybils (audit lead, accepted): MIN_CROWD counts distinct eligible accounts, and one person can
/// fund several attested accounts, so it is an anonymity-set heuristic, not a proof of distinct savers. A sybil crowd
/// can only thin its co-savers' anonymity set; it cannot move prices or funds: the keeper picks its own (secret) time,
/// and the public fallback needs the crowd complete before the fallback opened plus a fresh oracle round (M-1).
contract CrowdBuy is Ownable2Step, ReentrancyGuard, ChangeDelay {
    using SafeERC20 for IERC20;

    struct Book {
        uint256 usdgTotal;
        uint32 accounts;
        uint64 openedAt;
        uint256 rawOut;
        bool executed;
        uint64 crowdSince; // when `accounts` last reached MIN_CROWD (0 while below it)
    }

    struct Settlement {
        uint32 settledAccounts; // accounts that have claimed or been delivered
        uint256 settledRaw; // raw tokens paid out so far
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    uint8 public constant MODE_QUIET = 1;
    uint8 public constant MODE_HIDDEN = 2;
    uint256 public constant STEALTH_SCHEME = 1;
    /// Hard floor for the deploy-time WINDOW; it must also exceed the beacon's GRACE (checked at deploy).
    uint64 public constant MIN_WINDOW = 1 hours;
    uint256 private constant BPS = 10_000;
    /// The public fallback only runs on a price round published after it opened and at most this old (audit M-1).
    uint64 public constant PUBLIC_FRESHNESS = 15 minutes;
    /// A public execution's band over the pool fee (review v2 L-4).
    uint256 public constant PUBLIC_EXTRA_BPS = 10;
    /// Most closed-market fallback times `missedFrom` skips (a four-day holiday weekend is 4).
    uint256 public constant MAX_CLOSED_FALLBACKS = 10;

    SavingsVault public immutable vault;
    StockRouter public immutable router;
    IExecuteBeacon public immutable beacon;
    Valuer public immutable valuer;
    StockTokenRegistry public immutable registry;
    IERC20 public immutable usdg;
    uint32 public immutable MIN_CROWD;
    uint16 public immutable slippageBps;
    uint64 public immutable GENESIS;
    /// Execution window length (mainnet/fork 1 day, testnet 2 hours): one book execution per window.
    uint64 public immutable WINDOW;

    address public keeper;
    StealthClaims public stealthClaims;
    IShieldedDeposit public shieldedPool;

    mapping(address asset => uint256) public currentBookId;
    mapping(address asset => mapping(uint256 bookId => Book)) private _books;
    mapping(address asset => mapping(uint256 bookId => Settlement)) private _settlements;
    mapping(address asset => mapping(uint256 bookId => mapping(address user => uint256))) public orderOf;
    mapping(address asset => mapping(uint256 bookId => mapping(address user => bool))) public settled;
    mapping(address asset => uint64) public lastExecutedWindow; // windowStart + 1, 0 = never
    mapping(address asset => uint256) public dust;

    event KeeperSet(address indexed keeper);
    event BookOpened(address indexed asset, uint256 indexed bookId, uint64 openedAt);
    event Joined(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg);
    event Cancelled(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg);
    event Executed(
        address indexed asset, uint256 indexed bookId, uint256 usdgTotal, uint256 rawOut, uint32 accounts, uint80 roundId
    );
    event Claimed(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw);
    event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw);
    event DustSettled(address indexed asset, uint256 indexed bookId, uint256 raw);
    event StealthClaimsSet(address indexed stealthClaims);
    event ShieldedPoolSet(address indexed shieldedPool);

    error ZeroAddress();
    error BadParam();
    error BadWindow();
    error NotKeeper();
    error NothingPending();
    error NoOrder();
    error AlreadyExecuted();
    error NotExecuted();
    error AlreadySettled();
    error CrowdTooSmall(uint32 accounts, uint32 minCrowd);
    error TooEarly(uint64 executeAfter);
    error AlreadyExecutedThisWindow(uint64 windowStart);
    error MarketOnHold(address asset);
    error StalePrice(uint256 updatedAt, uint64 openedAt);
    error CrowdTooLate(uint64 crowdSince, uint64 openedAt);
    error BeforeGenesis();
    error NotYet();
    error AlreadySet();
    error QuietNotConfigured();
    error UnknownRoute(bytes route);
    error NotQuiet(address user);
    error NoMetaAddress(address user);
    error BadEphemeralKey();
    error HiddenNotConfigured();
    error NotHidden(address user);
    error NoHiddenKeys(address user);
    error NoCanonicalMix(address user);
    error BadMetaAddress(address user);
    error NotUserOrKeeper();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        SavingsVault vault_,
        StockRouter router_,
        IExecuteBeacon beacon_,
        uint32 minCrowd_,
        uint16 slippageBps_,
        uint64 genesis_,
        address owner_,
        address keeper_,
        uint64 window_
    ) Ownable(owner_) {
        if (address(vault_) == address(0) || address(router_) == address(0) || address(beacon_) == address(0)) {
            revert ZeroAddress();
        }
        if (minCrowd_ == 0 || slippageBps_ > MAX_SLIPPAGE_BPS) revert BadParam();
        if (window_ < MIN_WINDOW || window_ <= beacon_.GRACE()) revert BadWindow();
        WINDOW = window_;
        vault = vault_;
        router = router_;
        beacon = beacon_;
        valuer = router_.valuer();
        registry = router_.registry();
        usdg = vault_.usdg();
        if (address(router_.usdg()) != address(usdg)) revert BadParam();
        MIN_CROWD = minCrowd_;
        slippageBps = slippageBps_;
        GENESIS = genesis_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// A new keeper waits CHANGE_DELAY (48 h) in public; removing the keeper (zero) applies at once: books then run
    /// through the public fallback only.
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ != address(0) && !_delayed()) return;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    /// A new owner starts with no queued changes (ChangeDelay nonce, review v2 L-6).
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        _bumpChangeNonce();
    }

    /// Set once: CrowdBuy is deployed first, then StealthClaims(crowd), then this.
    function setStealthClaims(StealthClaims sc) external onlyOwner {
        if (address(stealthClaims) != address(0)) revert AlreadySet();
        if (address(sc) == address(0)) revert ZeroAddress();
        if (sc.crowd() != address(this)) revert BadParam();
        stealthClaims = sc;
        emit StealthClaimsSet(address(sc));
    }

    /// Set once: ShieldedPool is deployed, its setCrowd(this) called, then this.
    function setShieldedPool(IShieldedDeposit pool) external onlyOwner {
        if (address(shieldedPool) != address(0)) revert AlreadySet();
        if (address(pool) == address(0)) revert ZeroAddress();
        if (pool.crowd() != address(this)) revert BadParam();
        shieldedPool = pool;
        emit ShieldedPoolSet(address(pool));
    }

    // ---------------------------------------------------------------- orders

    /// Moves `user`'s own pending USDG into `user`'s own orders. Only the user or the keeper may call: a stranger
    /// joining for someone could front-run that saver's withdraw of pending USDG and force them to cancel a book
    /// order to get it back (audit L-3). The keeper sweeps many users at once with `joinBatch`.
    /// Split by mix weight (floor); the last placed entry takes the remainder so the whole sweep is placed.
    /// A mix entry whose token is no longer canonical (delisted after the saver chose it) gets nothing: its weight is
    /// shared among the still-canonical entries, so no USDG feeds a book that can never execute (audit L-2). With no
    /// canonical entry left the join reverts and the USDG stays withdrawable in the vault.
    /// Deliberately not nonReentrant: a join that lands while a book is executing goes to the new book (R8).
    /// Buying: the user must pass the vault's eligibility gate (exits below never check it).
    function join(address user) external {
        if (msg.sender != user && msg.sender != keeper) revert NotUserOrKeeper();
        if (!vault.canBuy(user)) revert SavingsVault.NotEligible(user);
        (SavingsVault.MixEntry[] memory mix, uint256 amount) = vault.sweep(user);
        if (amount == 0) revert NothingPending();
        _place(user, mix, amount);
    }

    /// Keeper: joins every user that can join now and skips (never reverts on) the rest, so one saver's state never
    /// blocks the others. Returns how many joined.
    function joinBatch(address[] calldata users) external onlyKeeper returns (uint256 joined) {
        for (uint256 i; i < users.length; ++i) {
            address user = users[i];
            if (!vault.canBuy(user)) continue;
            (, uint256 pending) = vault.balancesOf(user);
            if (pending == 0 || _canonicalWeight(vault.mixOf(user)) == 0) continue;
            (SavingsVault.MixEntry[] memory mix, uint256 amount) = vault.sweep(user);
            _place(user, mix, amount);
            ++joined;
        }
    }

    /// Cancels msg.sender's whole order in a not-yet-executed book; the USDG goes back to their vault balance.
    function cancel(address asset, uint256 bookId) external nonReentrant {
        Book storage b = _books[asset][bookId];
        if (b.executed) revert AlreadyExecuted();
        uint256 order = orderOf[asset][bookId][msg.sender];
        if (order == 0) revert NoOrder();
        orderOf[asset][bookId][msg.sender] = 0;
        b.usdgTotal -= order;
        b.accounts -= 1;
        if (b.accounts < MIN_CROWD) b.crowdSince = 0;
        usdg.forceApprove(address(vault), order);
        vault.refundFromCrowd(msg.sender, order);
        emit Cancelled(asset, bookId, msg.sender, order);
    }

    // ---------------------------------------------------------------- execution

    /// Fixed WINDOW grid from GENESIS.
    function windowOf(uint256 t) public view returns (uint64 start, uint64 end) {
        if (t < GENESIS) revert BeforeGenesis();
        start = GENESIS + uint64((t - GENESIS) / WINDOW) * WINDOW;
        end = start + WINDOW;
    }

    /// The JitterBeacon key the keeper commits for (asset, window): keccak256(abi.encode(asset, windowStart)).
    function beaconKey(address asset, uint64 windowStart) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, windowStart));
    }

    /// The keeper. Requires: crowd >= MIN_CROWD, the window's beacon time has passed, not yet executed this
    /// window, and the oracle is not on hold (stale, market closed, sequencer down). The router enforces an
    /// oracle-based minOut.
    /// Keeper-only because whoever executes picks the block: a stranger could move the pool, execute the whole
    /// book against it up to the slippage band and move it back in one transaction. So that a dead keeper never
    /// blocks a book, anyone may execute a book the keeper missed: from the first `windowEnd - beacon.GRACE()` (the
    /// beacon's own fallback time) in open market of a window the book had its crowd for and did not execute in
    /// (`missedFrom`; a weekend or holiday never counts as the keeper's miss), at any later time the market is open,
    /// once per window (review v2 L-3: one fixed hour a day rarely had a round in it). Only when (audit M-1):
    ///   - the oracle round was published after `missedFrom` and is at most PUBLIC_FRESHNESS old, so the book is
    ///     never bought at a stale-but-"fresh" price (Friday's close on a weekend) that a sandwich could push the
    ///     pool back to;
    ///   - the book already had MIN_CROWD accounts before `missedFrom`, so a sybil cannot hold a book under the
    ///     minimum (keeping the keeper out) and complete the crowd in the same transaction as the execution; and
    ///   - within `publicSlippageBps`: the pool's own fee plus PUBLIC_EXTRA_BPS (and never more than half the keeper
    ///     band), so pushing the pool off the oracle before a public execution cannot pay (review v2 L-4, BAT-1).
    /// A pool too far off, or no fresh round, simply waits (savers can always cancel).
    function execute(address asset) external nonReentrant {
        uint256 bookId = currentBookId[asset];
        Book storage b = _books[asset][bookId];
        if (b.executed) revert AlreadyExecuted(); // unreachable: the current book is never executed
        if (b.accounts < MIN_CROWD) revert CrowdTooSmall(b.accounts, MIN_CROWD);
        (uint64 start, uint64 end) = windowOf(block.timestamp);
        uint16 slip = slippageBps;
        bool fallback_ = msg.sender != keeper;
        uint64 publicFrom;
        if (fallback_) {
            if (b.crowdSince == 0) revert CrowdTooLate(0, 0);
            publicFrom = missedFrom(asset, b.crowdSince);
            if (block.timestamp < publicFrom) revert NotKeeper();
            slip = publicSlippageBps(asset);
        }
        if (lastExecutedWindow[asset] == start + 1) revert AlreadyExecutedThisWindow(start);
        if (!fallback_) {
            uint64 after_ = beacon.executeAfter(beaconKey(asset, start));
            // A window the keeper never committed (keeper dead from the start) falls back to the same public time as
            // an unrevealed commitment, so a dead keeper never blocks a book (audit L-1).
            uint64 windowPublic = end - beacon.GRACE();
            if (after_ > windowPublic) after_ = windowPublic;
            if (block.timestamp < after_) revert TooEarly(after_);
        }
        Valuer.Quote memory q = valuer.quote(asset);
        if (q.hold) revert MarketOnHold(asset);
        if (fallback_ && (q.updatedAt < publicFrom || block.timestamp > q.updatedAt + PUBLIC_FRESHNESS)) {
            revert StalePrice(q.updatedAt, publicFrom);
        }

        // Effects before the swap: from here on, joins land in the next book.
        uint256 total = b.usdgTotal;
        uint32 accounts = b.accounts;
        b.executed = true;
        lastExecutedWindow[asset] = start + 1;
        _openNext(asset, bookId);

        IERC20 token = IERC20(asset);
        uint256 before = token.balanceOf(address(this));
        usdg.forceApprove(address(router), total);
        router.buy(asset, total, slip, address(this));
        uint256 rawOut = token.balanceOf(address(this)) - before;
        b.rawOut = rawOut;
        emit Executed(asset, bookId, total, rawOut, accounts, q.roundId);
    }

    /// When the public fallback opens for a book whose crowd formed at `crowdSince`: the fallback time
    /// (`windowEnd - beacon.GRACE()`) of the window the crowd formed in, if it formed before that time and no book
    /// executed in that window; else the next window's. A fallback time at which the market is closed (a weekend, a
    /// holiday, the closed part of an early-close day, or past the calendar's validity) does not count: the keeper
    /// could not execute in that window, so the fallback moves on to the first window whose fallback time is in open
    /// market. A book that completes over a weekend therefore stays the keeper's through the whole first open day (its
    /// secret beacon time), and opens to the public only GRACE before that window ends (review v3 R3-ORC-1).
    /// From then on the book counts as missed by the keeper.
    function missedFrom(address asset, uint64 crowdSince) public view returns (uint64) {
        uint64 t = crowdSince < GENESIS ? GENESIS : crowdSince;
        (uint64 start, uint64 end) = windowOf(t);
        uint64 from = end - beacon.GRACE();
        if (crowdSince >= from || lastExecutedWindow[asset] == start + 1) from += WINDOW;
        if (!valuer.marketCalendar()) return from;
        uint256 until = valuer.calendarValidUntil();
        // At most a long holiday weekend plus slack; past it the hold check in execute still refuses.
        for (uint256 i; i < MAX_CLOSED_FALLBACKS && (from >= until || valuer.isClosedAt(from)); ++i) {
            from += WINDOW;
        }
        return from;
    }

    /// The slippage band of a public execution: the asset's pool fee (rounded up to whole bps) plus
    /// PUBLIC_EXTRA_BPS, and never more than half the keeper band.
    function publicSlippageBps(address asset) public view returns (uint16) {
        uint256 band = (uint256(router.poolOf(asset).fee) + 99) / 100 + PUBLIC_EXTRA_BPS;
        uint256 half = slippageBps / 2;
        return uint16(band < half ? band : half);
    }

    // ---------------------------------------------------------------- settlement

    /// floor(rawOut * order / usdgTotal), raw token units. 0 before execution.
    function allocationOf(address asset, uint256 bookId, address user) public view returns (uint256 raw) {
        Book storage b = _books[asset][bookId];
        if (!b.executed || b.usdgTotal == 0) return 0;
        return Math.mulDiv(b.rawOut, orderOf[asset][bookId][user], b.usdgTotal);
    }

    /// The ungated exit: always allowed for the user's own allocation, whatever their delivery mode.
    function claimOpen(address asset, uint256 bookId) external nonReentrant {
        uint256 raw = _settle(asset, bookId, msg.sender);
        if (raw != 0) IERC20(asset).safeTransfer(msg.sender, raw);
        emit Claimed(asset, bookId, msg.sender, raw);
    }

    /// Keeper delivery for a non-Open user.
    /// Quiet: `route` = abi.encode(uint8 1). Settles the user's whole allocation and moves it into
    /// StealthClaims' unassigned pool; `deliverStealth` assigns it later. Requires vault mode Quiet and an
    /// ERC-6538 scheme-1 meta-address on record, so the keeper cannot redirect Open users' tokens.
    /// Hidden: `route` = abi.encode(uint8 2, bytes32 blinding, bytes encryptedNote). Requires vault mode
    /// Hidden and registered hidden keys; the note's owner key comes from the vault, never from the keeper.
    function deliver(address asset, uint256 bookId, address user, bytes calldata route)
        external
        onlyKeeper
        nonReentrant
    {
        if (route.length < 32) revert UnknownRoute(route);
        uint256 word = uint256(bytes32(route[:32]));
        if (word == MODE_HIDDEN) return _deliverHidden(asset, bookId, user, route);
        if (route.length != 32 || word != MODE_QUIET) revert UnknownRoute(route);
        StealthClaims sc = stealthClaims;
        if (address(sc) == address(0)) revert QuietNotConfigured();
        if (vault.settingsOf(user).mode != MODE_QUIET) revert NotQuiet(user);
        bytes memory meta = sc.registry().stealthMetaAddressOf(user, STEALTH_SCHEME);
        if (meta.length == 0) revert NoMetaAddress(user);
        if (!KeyChecks.isValidMetaAddress(meta)) revert BadMetaAddress(user);
        uint256 raw = _settle(asset, bookId, user);
        if (raw != 0) {
            IERC20(asset).safeTransfer(address(sc), raw);
            sc.pool(asset, raw);
        }
        emit Delivered(asset, bookId, user, raw);
    }

    function _deliverHidden(address asset, uint256 bookId, address user, bytes calldata route) private {
        IShieldedDeposit pool = shieldedPool;
        if (address(pool) == address(0)) revert HiddenNotConfigured();
        (, bytes32 blinding, bytes memory encryptedNote) = abi.decode(route, (uint8, bytes32, bytes));
        if (vault.settingsOf(user).mode != MODE_HIDDEN) revert NotHidden(user);
        bytes32 ownerPk = vault.hiddenKeysOf(user).ownerPk;
        if (ownerPk == 0) revert NoHiddenKeys(user);
        uint256 raw = _settle(asset, bookId, user);
        if (raw != 0) {
            IERC20(asset).forceApprove(address(pool), raw);
            pool.depositFor(asset, raw, ownerPk, blinding, encryptedNote, user);
        }
        emit Delivered(asset, bookId, user, raw);
    }

    /// Assigns `raw` pooled tokens to one stealth address and announces it (ERC-5564 scheme 1).
    /// Announcement metadata: viewTag (1 byte) | transfer selector (4) | token (20) | raw amount (32).
    function deliverStealth(address asset, address stealth, uint256 raw, bytes calldata ephemeralPubKey, bytes1 viewTag)
        external
        onlyKeeper
        nonReentrant
    {
        StealthClaims sc = stealthClaims;
        if (address(sc) == address(0)) revert QuietNotConfigured();
        if (ephemeralPubKey.length != 33 || (ephemeralPubKey[0] != 0x02 && ephemeralPubKey[0] != 0x03)) {
            revert BadEphemeralKey();
        }
        sc.credit(asset, stealth, raw);
        sc.announcer().announce(
            STEALTH_SCHEME, stealth, ephemeralPubKey, abi.encodePacked(viewTag, IERC20.transfer.selector, asset, raw)
        );
    }

    // ---------------------------------------------------------------- views

    /// Whether `user`'s ERC-6538 scheme-1 meta-address is well formed (66 bytes, two on-curve compressed secp256k1
    /// keys). `deliver` refuses a Quiet user without one; the keeper checks this first and skips them (audit M-6).
    function metaAddressValid(address user) external view returns (bool) {
        StealthClaims sc = stealthClaims;
        if (address(sc) == address(0)) return false;
        return KeyChecks.isValidMetaAddress(sc.registry().stealthMetaAddressOf(user, STEALTH_SCHEME));
    }

    function book(address asset, uint256 bookId) external view returns (Book memory) {
        return _books[asset][bookId];
    }

    function openBook(address asset) external view returns (uint256 bookId, Book memory b) {
        bookId = currentBookId[asset];
        b = _books[asset][bookId];
    }

    function settlement(address asset, uint256 bookId) external view returns (Settlement memory) {
        return _settlements[asset][bookId];
    }

    // ---------------------------------------------------------------- internal

    function _canonicalWeight(SavingsVault.MixEntry[] memory mix) private view returns (uint256 weightSum) {
        for (uint256 i; i < mix.length; ++i) {
            if (registry.isCanonical(mix[i].stockToken)) weightSum += mix[i].weightBps;
        }
    }

    function _place(address user, SavingsVault.MixEntry[] memory mix, uint256 amount) private {
        uint256 weightSum = _canonicalWeight(mix);
        if (weightSum == 0) revert NoCanonicalMix(user);
        uint256 lastLive;
        for (uint256 i; i < mix.length; ++i) {
            if (registry.isCanonical(mix[i].stockToken)) lastLive = i;
        }
        uint256 placed;
        for (uint256 i; i <= lastLive; ++i) {
            if (!registry.isCanonical(mix[i].stockToken)) continue;
            uint256 part = i == lastLive ? amount - placed : amount * mix[i].weightBps / weightSum;
            placed += part;
            if (part != 0) _addOrder(mix[i].stockToken, user, part);
        }
    }

    function _addOrder(address asset, address user, uint256 amount) private {
        uint256 bookId = currentBookId[asset];
        Book storage b = _books[asset][bookId];
        if (b.openedAt == 0) {
            b.openedAt = uint64(block.timestamp);
            emit BookOpened(asset, bookId, b.openedAt);
        }
        mapping(address => uint256) storage orders = orderOf[asset][bookId];
        if (orders[user] == 0) {
            b.accounts += 1;
            if (b.accounts == MIN_CROWD) b.crowdSince = uint64(block.timestamp);
        }
        orders[user] += amount;
        b.usdgTotal += amount;
        emit Joined(asset, bookId, user, amount);
    }

    function _openNext(address asset, uint256 bookId) private {
        uint256 next = bookId + 1;
        currentBookId[asset] = next;
        uint64 t = uint64(block.timestamp);
        _books[asset][next].openedAt = t;
        emit BookOpened(asset, next, t);
    }

    /// Marks `user` settled for the book and returns their allocation. When the last account settles,
    /// whatever was not allocated becomes dust.
    function _settle(address asset, uint256 bookId, address user) private returns (uint256 raw) {
        Book storage b = _books[asset][bookId];
        if (!b.executed) revert NotExecuted();
        if (orderOf[asset][bookId][user] == 0) revert NoOrder();
        if (settled[asset][bookId][user]) revert AlreadySettled();
        settled[asset][bookId][user] = true;
        raw = allocationOf(asset, bookId, user);
        Settlement storage s = _settlements[asset][bookId];
        s.settledAccounts += 1;
        s.settledRaw += raw;
        if (s.settledAccounts == b.accounts) {
            uint256 d = b.rawOut - s.settledRaw;
            dust[asset] += d;
            emit DustSettled(asset, bookId, d);
        }
    }
}
