// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Valuer} from "../core/Valuer.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryAccount} from "./TreasuryAccount.sol";
import {AssetValuation} from "../libs/AssetValuation.sol";
import {ISleeve, IPeriodStartNav} from "../interfaces/ISleeve.sol";
import {ITierSource, Tier} from "../interfaces/ITierSource.sol";
import {IPrivateSleeve} from "./PrivateSleeve.sol";

/// Optional hook on the fee recipient (FeeRouter, todo 30).
interface ICloseFeeHook {
    function onCloseFee(address account, uint256 amount) external;
}

/// Every period ends with a statement the chain itself checks. The controller signs a `Close`; `commit`
/// recomputes, in the same call, everything the statement claims about the account's holdings:
///
/// - `navUsd` must equal `account.navUsd()` exactly (no tolerance), so a statement cannot claim money that
///   is not there;
/// - `cashBps` / `equityBps` must equal the band weights from the sleeves' own `valueOf` (plus the account's
///   loose cash, see TreasuryAccount);
/// - `positionsHash` must equal keccak256(abi.encode(Position[])) over every held asset (raw > 0), sorted
///   by address, each with its raw balance, USD price per whole token, multiplier and Chainlink round id;
/// - no held, canonical Stock Token's feed may be on hold (`HoldAtClose`; the service retries when markets
///   reopen). A delisted held token is recorded at price 0 and does not block the close (it is already
///   worth 0 in NAV);
/// - `policyHash` / `policyVersion` must be the TreasuryPolicy version in force at `periodEnd`, and the
///   signer must be that version's controller (EIP-712; ERC-1271 for a contract controller).
///
/// `bundleHash` is the keccak256 of the off-chain bundle JSON (positions, prices, desk actions, guard
/// denials) the CFO pack renders from; the chain only stores the hash.
///
/// After the checks a platform fee of navUsd x 25 bps x elapsed / 365 days is paid from the account's idle
/// cash (USDG) to `feeRecipient`; what idle cash cannot cover is carried as `feeOwed` to the next close.
/// Drawdown base (`periodStartNav`, read by the PolicyGuard drawdown rule). It is never re-read from the live
/// book after the checks (review3 R3-TREAS-3), and no board withdrawal can lower it (review4 R4-TREAS-3: a
/// withdrawToBoard just before the controller's snapshot, returned right after, stored $460k for a $1M book). At
/// the snapshot (or a live commit) the close measures, besides the signed statement S:
///   - G, the account's tracked token balances valued exactly as the guard values them (AssetValuation; no
///     sleeve's own `valueOf`, so a board-written sleeve that under-reports cannot lower it);
///   - W, the USD value of everything withdrawn to the board (`TreasuryAccount.boardWithdrawn`, per token)
///     since the previous close's measurement.
/// periodStartNav = max(S, G + proven private) + W - fee paid. A withdrawal therefore counts as drawdown in the
/// period it is made and in the next one, whether it comes back or not; a board that wants a lower base for a
/// legitimate reason changes the policy's drawdown bands (timelocked). Residual: the guard itself trusts the
/// board's adapters for venue and vault values (not part of G or of this fix).
///
/// Insurance claim basis (`claimBasisNav`, read by the ExceptionInsurancePool claim cap; review-v2 L-11, review3
/// R3-TREAS-2, review4 R4-TREAS-2): only value nothing the board writes can inflate: the account's balance of the
/// close's cash asset (USDG) at 1:1, its balances of registry-canonical Stock Tokens at Valuer prices, and the
/// proven private part, less the fee. Every sleeve's `valueOf`, cash vaults (board-chosen ERC-4626 code), venue
/// equity and any non-canonical token count 0 there. `claimBasisNow()` then subtracts every later DECREASE of the
/// account's trusted holdings below the measurement (review5 R5-TREAS-1), whatever form the value leaves in (USDG or
/// stock withdrawn, USDG moved into vault shares or a venue and withdrawn from there, stock shielded and spent): so
/// value lent in for the snapshot block and taken out again never lifts the cap. A fall in trusted holdings from any
/// cause (a loss, a price fall) lowers the cap for the rest of the period; a rise never raises it. The fee recipient is the FeeRouter in production.
///
/// Weekly close: when `tiers` is set, a period shorter than `WEEKLY_BELOW` (28 days) is accepted only while
/// the account's board holds a staking tier with `weeklyClose` (`TierTooLow` otherwise). Non-upgradeable.
///
/// Private sleeve (`commitWithPrivateSleeve`): when the account has a PrivateSleeve, NAV = the public part
/// (recomputed on-chain exactly as above) + a private lower bound proven by a circuits/treasury_close proof over
/// the sleeve's unspent notes at prices pinned from the Valuer in the same call; the proof also shows the band
/// weights (with the exact private value) are inside the policy bands of the version in force. `cashBps` /
/// `equityBps` count the proven private part in the sleeve's band; `positionsHash` covers public positions only;
/// the bundle notes the private part (root, proven NAV, prices commitment, nullifiers: `PrivateSleeveProven`).
/// The plain `commit` is refused while the sleeve's book is not empty, so a shielded book cannot drop out of a
/// statement (an empty sleeve proves 0 with an all-padding proof).
///
/// Snapshot close (audit L-4): the live `commit` recomputes the book at inclusion, so anyone could void a signed
/// Close by sending 1 wei of USDG (or of any tracked token) to the account before it lands. Instead, at or after
/// the period end the controller of the policy in force calls `snapshot()`, which records the positions hash, NAV,
/// band weights and the public context of a private close (public NAV and band USD) at that block; the service
/// builds and signs the Close from that block and `commitSnapshot` / `commitSnapshotWithPrivateSleeve` check the
/// signed statement against the stored snapshot instead of the live book. A snapshot is valid for
/// `SNAPSHOT_MAX_AGE`, must be taken at or after the Close's `periodEnd`, is consumed by the next commit, and only
/// the controller can take (or retake) one, so donations after it change nothing. The live path stays for
/// callers that can afford a retry.
///
/// Deployed either directly (constructor) or as an EIP-1167 clone by TreasuryFactory (`initialize`, once; the
/// EIP-712 domain uses the clone's own address). All-zero constructor arguments deploy a locked implementation.
contract PeriodClose is EIP712, IPeriodStartNav {
    struct Close {
        uint64 periodEnd;
        uint256 navUsd;
        uint16 cashBps;
        uint16 equityBps;
        bytes32 positionsHash;
        bytes32 bundleHash;
        bytes32 policyHash;
        uint32 policyVersion;
    }

    struct Position {
        address asset;
        uint256 raw;
        uint256 price; // USD (1e18) per 10**decimals raw units
        uint256 multiplier; // 1e18; Stock Tokens: uiMultiplier (already inside price), others 1e18
        uint80 roundId; // Chainlink round of the price; 0 for cash and vault shares
    }

    /// The book the controller pinned for the next commit (`snapshot`). `takenAt == 0`: none.
    struct BookSnapshot {
        uint64 takenAt;
        uint256 navUsd; // public NAV (account.navUsd)
        uint16 cashBps; // public weights (for a plain commit)
        uint16 equityBps;
        bytes32 positionsHash;
        uint256[3] bandUsd; // public cash / equity / basis USD (the private close's public context)
    }

    bytes32 public constant CLOSE_TYPEHASH = keccak256(
        "Close(uint64 periodEnd,uint256 navUsd,uint16 cashBps,uint16 equityBps,bytes32 positionsHash,bytes32 bundleHash,bytes32 policyHash,uint32 policyVersion)"
    );
    uint256 public constant FEE_BPS = 25;
    uint256 public constant YEAR = 365 days;
    uint256 private constant BPS = 10_000;
    uint32 public constant WEEKLY_BELOW = 28 days;
    /// A snapshot older than this cannot be committed (the controller retakes it).
    uint64 public constant SNAPSHOT_MAX_AGE = 6 hours;

    TreasuryAccount public account;
    TreasuryPolicy public policy;
    Valuer public valuer;
    IERC20 public cash;
    uint8 public cashDecimals;
    address public feeRecipient; // zero = no fee
    uint64 public startTime; // fee accrual start of the first period
    ITierSource public tiers; // zero = no tier gating (weekly close always allowed)
    bool private _initialized;

    Close[] private _closes;
    uint256 public periodStartNav;
    uint256 private transient _gNow;
    uint256 private transient _tNow;
    uint256 private transient _wNow;
    uint256 private transient _provenNow;
    uint256 public feeOwed; // cash raw units not yet paid
    BookSnapshot private _snap;
    // Appended after the pre-review3 layout (review4 I-3).
    /// Insurance claim basis at the last close: USDG + canonical Stock Tokens + proven private, less the fee.
    uint256 public claimBasisNav;
    /// `TreasuryAccount.boardWithdrawn(token)` at the last close's measurement (W and `claimBasisNow` count from it).
    mapping(address token => uint256) public withdrawnMark;
    mapping(address token => uint256) private _withdrawnPending; // the same, at the pinned snapshot
    /// The pinned snapshot's measurement: guard-valued tokens (G), trusted value (T), withdrawn since mark (W).
    uint256[3] private _snapMeasure;
    /// The account's public trusted holdings (T) at the last close's measurement, less the fee it paid.
    uint256 public trustedAtClose;

    event BookSnapshotted(uint64 takenAt, bytes32 positionsHash, uint256 navUsd, uint16 cashBps, uint16 equityBps);
    event PeriodClosed(
        uint256 indexed index, uint64 indexed periodEnd, Close close, uint256 feeRaw, uint256 feePaid, uint256 feeOwed
    );

    error ZeroAddress();
    error PeriodInFuture(uint64 periodEnd, uint256 nowTs);
    error PeriodTooEarly(uint64 periodEnd, uint64 earliest);
    error NoPolicyAt(uint64 periodEnd);
    error PolicyMismatch(bytes32 hash, uint32 version);
    error HoldAtClose(address token);
    error NavMismatch(uint256 expected, uint256 claimed);
    error WeightsMismatch(uint16 cashBps, uint16 equityBps);
    error PositionsMismatch(bytes32 expected);
    error BadSignature();
    error TierTooLow(address board);
    error AlreadyInitialized();
    error NoPrivateSleeve();
    error PrivateBookOpen(uint256 bookUsd);
    error NotController();
    error NoSnapshot();
    error SnapshotBeforePeriodEnd(uint64 takenAt, uint64 periodEnd);
    error SnapshotExpired(uint64 takenAt);

    event PrivateBookRefreshed(bytes32 root, uint256 privateNavUsd, bytes32 pricesCommitment, bytes32[8] nullifiers);
    event PrivateSleeveProven(
        uint256 indexed index, bytes32 root, uint256 privateNavUsd, bytes32 pricesCommitment, bytes32[8] nullifiers
    );

    constructor(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        EIP712("Plynth PeriodClose", "1")
    {
        if (
            address(account_) == address(0) && address(cash_) == address(0) && feeRecipient_ == address(0)
                && address(tiers_) == address(0)
        ) {
            _initialized = true; // implementation for clones: never usable itself
            return;
        }
        _init(account_, cash_, feeRecipient_, tiers_);
    }

    /// Clone setup (TreasuryFactory), once. The account must already be initialized (policy and guard are read).
    function initialize(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        external
    {
        _init(account_, cash_, feeRecipient_, tiers_);
    }

    function _init(TreasuryAccount account_, IERC20Metadata cash_, address feeRecipient_, ITierSource tiers_)
        private
    {
        if (_initialized) revert AlreadyInitialized();
        if (address(account_) == address(0) || address(cash_) == address(0)) revert ZeroAddress();
        _initialized = true;
        account = account_;
        policy = account_.policy();
        valuer = account_.guard().valuer();
        cash = cash_;
        cashDecimals = cash_.decimals();
        feeRecipient = feeRecipient_;
        startTime = uint64(block.timestamp);
        tiers = tiers_;
    }

    // ---------------------------------------------------------------- commit

    /// The live path: the statement is checked against the book at inclusion (any transfer to the account between
    /// signing and inclusion voids it; prefer `snapshot` + `commitSnapshot`).
    function commit(Close calldata c, bytes calldata controllerSig) external {
        (bytes32 posHash,) = _positions(true);
        (uint256 nav,) = account.navUsd();
        _measureNow();
        _commitPublic(c, controllerSig, posHash, nav, _bandUsd());
    }

    /// `commit` for an account with a private sleeve: `c.navUsd` = public NAV + `p.navUsd` (proven lower bound).
    function commitWithPrivateSleeve(
        Close calldata c,
        bytes calldata controllerSig,
        IPrivateSleeve.PrivateClose calldata p
    ) external {
        (bytes32 posHash,) = _positions(true);
        (uint256 pubNav,) = account.navUsd();
        _measureNow();
        _commitPrivate(c, controllerSig, p, posHash, pubNav, _bandUsd());
    }

    /// Anyone: refreshes the private sleeve's book between closes with a treasury_close proof over the live public
    /// book and the bands of the policy in force (audit L-6), so a long period does not leave the guard on a stale
    /// book. The proof is a lower bound of unspent notes at Valuer prices now, so it can only replace the book with
    /// value that provably exists. Nothing is recorded as a close.
    function refreshPrivateBook(IPrivateSleeve.PrivateClose calldata p) external {
        IPrivateSleeve ps = IPrivateSleeve(account.privateSleeve());
        if (address(ps) == address(0)) revert NoPrivateSleeve();
        (TreasuryPolicy.Policy memory pol, bytes32 h,) = policy.current();
        IPrivateSleeve.BookContext memory ctx;
        (ctx.pubNav,) = account.navUsd();
        ctx.pubBandUsd = _bandUsd();
        ctx.policyHash = h;
        ctx.bandMin = [pol.cash.minBps, pol.equity.minBps, pol.basis.minBps];
        ctx.bandMax = [pol.cash.maxBps, pol.equity.maxBps, pol.basis.maxBps];
        bytes32 pc = ps.checkClose(p, ctx);
        ps.onClose(p.navUsd, p.nullifiers);
        emit PrivateBookRefreshed(p.root, p.navUsd, pc, p.nullifiers);
    }

    /// The controller of the policy in force pins the book for the next commit: positions hash, NAV, weights and
    /// band USD at this block (reverts HoldAtClose like `commit`). Only from the earliest next period end on; a
    /// new snapshot replaces the old one.
    function snapshot() external returns (bytes32 positionsHash, uint256 navUsd, uint16 cashBps, uint16 equityBps) {
        (TreasuryPolicy.Policy memory p,,) = policy.current();
        if (msg.sender != p.controller) revert NotController();
        uint64 earliest = nextPeriodEnd();
        if (block.timestamp < earliest) revert PeriodInFuture(earliest, block.timestamp);
        (positionsHash,) = _positions(true);
        (navUsd,) = account.navUsd();
        uint256[3] memory band = _bandUsd();
        (cashBps, equityBps) = _weightsOf(band, navUsd);
        _snap = BookSnapshot(uint64(block.timestamp), navUsd, cashBps, equityBps, positionsHash, band);
        _snapMeasure = _measure();
        emit BookSnapshotted(uint64(block.timestamp), positionsHash, navUsd, cashBps, equityBps);
    }

    /// `commit` checked against the stored snapshot instead of the live book.
    function commitSnapshot(Close calldata c, bytes calldata controllerSig) external {
        BookSnapshot memory b = _useSnapshot(c.periodEnd);
        _commitPublic(c, controllerSig, b.positionsHash, b.navUsd, b.bandUsd);
    }

    /// `commitWithPrivateSleeve` with the public part (positions, public NAV, band USD) from the stored snapshot.
    /// The private proof's prices are still pinned from the Valuer at inclusion.
    function commitSnapshotWithPrivateSleeve(
        Close calldata c,
        bytes calldata controllerSig,
        IPrivateSleeve.PrivateClose calldata p
    ) external {
        BookSnapshot memory b = _useSnapshot(c.periodEnd);
        _commitPrivate(c, controllerSig, p, b.positionsHash, b.navUsd, b.bandUsd);
    }

    function _useSnapshot(uint64 periodEnd) private returns (BookSnapshot memory b) {
        b = _snap;
        uint256[3] memory m = _snapMeasure;
        (_gNow, _tNow, _wNow) = (m[0], m[1], m[2]);
        if (b.takenAt == 0) revert NoSnapshot();
        if (b.takenAt < periodEnd) revert SnapshotBeforePeriodEnd(b.takenAt, periodEnd);
        if (block.timestamp > b.takenAt + SNAPSHOT_MAX_AGE) revert SnapshotExpired(b.takenAt);
        delete _snap; // consumed once
        delete _snapMeasure;
    }

    function _commitPublic(
        Close calldata c,
        bytes calldata controllerSig,
        bytes32 posHash,
        uint256 nav,
        uint256[3] memory band
    ) private {
        uint64 prevEnd = _checkTiming(c.periodEnd);
        address controller = _checkPolicy(c);
        _checkTier(prevEnd, c.periodEnd);
        address ps = account.privateSleeve();
        if (ps != address(0)) {
            uint256 book = IPrivateSleeve(ps).bookUsd();
            if (book != 0) revert PrivateBookOpen(book);
        }

        if (c.navUsd != nav) revert NavMismatch(nav, c.navUsd);
        (uint16 cashBps, uint16 equityBps) = _weightsOf(band, nav);
        if (c.cashBps != cashBps || c.equityBps != equityBps) revert WeightsMismatch(cashBps, equityBps);
        if (c.positionsHash != posHash) revert PositionsMismatch(posHash);

        if (!SignatureChecker.isValidSignatureNow(controller, digest(c), controllerSig)) revert BadSignature();

        _record(c, prevEnd);
    }

    function _commitPrivate(
        Close calldata c,
        bytes calldata controllerSig,
        IPrivateSleeve.PrivateClose calldata p,
        bytes32 posHash,
        uint256 pubNav,
        uint256[3] memory pubBand
    ) private {
        uint64 prevEnd = _checkTiming(c.periodEnd);
        address controller = _checkPolicy(c);
        _checkTier(prevEnd, c.periodEnd);
        IPrivateSleeve ps = IPrivateSleeve(account.privateSleeve());
        if (address(ps) == address(0)) revert NoPrivateSleeve();

        if (c.positionsHash != posHash) revert PositionsMismatch(posHash);
        bytes32 pc = _checkPrivate(c, p, ps, pubNav, pubBand);
        if (!SignatureChecker.isValidSignatureNow(controller, digest(c), controllerSig)) revert BadSignature();

        _provenNow = p.navUsd;
        uint256 index = _record(c, prevEnd); // c.navUsd = checked public part + proven private part
        ps.onClose(p.navUsd, p.nullifiers);
        emit PrivateSleeveProven(index, p.root, p.navUsd, pc, p.nullifiers);
    }

    /// Stores the close, pays the fee on its NAV and sets the next period's start from the checked statement.
    function _record(Close calldata c, uint64 prevEnd) private returns (uint256 index) {
        _closes.push(c);
        index = _closes.length - 1;
        (uint256 feeRaw, uint256 paid, uint256 owed) = _fee(c.navUsd, c.periodEnd - prevEnd);
        emit PeriodClosed(index, c.periodEnd, c, feeRaw, paid, owed);
        _setStart(c.navUsd, paid);
    }

    /// The next period's drawdown base and claim basis from this close's measurement (see the contract notes), and
    /// the withdrawal marks move to the measurement's counters.
    function _setStart(uint256 statementNav, uint256 feePaidRaw) private {
        uint8 dec = cashDecimals;
        uint256 feeUsd = dec <= 18 ? feePaidRaw * 10 ** (18 - dec) : feePaidRaw / 10 ** (dec - 18);
        uint256 proven = _provenNow;
        uint256 g = _gNow + proven;
        uint256 base = (statementNav > g ? statementNav : g) + _wNow;
        periodStartNav = base > feeUsd ? base - feeUsd : 0;
        uint256 t = _tNow;
        t = t > feeUsd ? t - feeUsd : 0;
        trustedAtClose = t;
        claimBasisNav = t + proven;
        (address[] memory assets,,) = account.trackedAssets();
        for (uint256 i; i < assets.length; ++i) {
            withdrawnMark[assets[i]] = _withdrawnPending[assets[i]];
        }
    }

    function _measureNow() private {
        uint256[3] memory m = _measure();
        (_gNow, _tNow, _wNow) = (m[0], m[1], m[2]);
    }

    /// [G, T, W] now (see the contract notes); records the board-withdrawal counters as pending marks.
    function _measure() private returns (uint256[3] memory m) {
        (address[] memory assets, uint8[] memory kinds,) = account.trackedAssets();
        for (uint256 i; i < assets.length; ++i) {
            address a = assets[i];
            uint256 out = account.boardWithdrawn(a);
            _withdrawnPending[a] = out;
            (uint256 g,) = AssetValuation.value(valuer, a, kinds[i], IERC20(a).balanceOf(address(account)));
            m[0] += g;
            m[1] += _trustedUsd(a, IERC20(a).balanceOf(address(account)));
            uint256 since = out - withdrawnMark[a];
            if (since != 0) {
                (uint256 w,) = AssetValuation.value(valuer, a, kinds[i], since);
                m[2] += w;
            }
        }
    }

    /// Value that nothing the board writes can inflate: the close's cash asset 1:1, canonical Stock Tokens at
    /// Valuer prices, everything else 0.
    function _trustedUsd(address a, uint256 raw) private view returns (uint256 usd) {
        if (raw == 0) return 0;
        if (a == address(cash)) return AssetValuation.to1e18(raw, cashDecimals);
        if (valuer.registry().isCanonical(a)) (usd,) = valuer.value(a, raw);
    }

    /// The claim basis less every decrease of the account's trusted holdings since the last close's measurement.
    function claimBasisNow() external view returns (uint256) {
        (address[] memory assets,,) = account.trackedAssets();
        uint256 t;
        for (uint256 i; i < assets.length; ++i) {
            t += _trustedUsd(assets[i], IERC20(assets[i]).balanceOf(address(account)));
        }
        uint256 ref = trustedAtClose;
        uint256 drop = ref > t ? ref - t : 0;
        uint256 basis = claimBasisNav;
        return basis > drop ? basis - drop : 0;
    }

    /// NAV and weights with the private part in the sleeve's band, then the proof against the public book and the
    /// bands of the policy version the close names (already checked to be the one in force).
    function _checkPrivate(
        Close calldata c,
        IPrivateSleeve.PrivateClose calldata p,
        IPrivateSleeve ps,
        uint256 pubNav,
        uint256[3] memory pubBand
    ) private view returns (bytes32) {
        IPrivateSleeve.BookContext memory ctx;
        ctx.pubNav = pubNav;
        uint256 nav = pubNav + p.navUsd;
        if (c.navUsd != nav) revert NavMismatch(nav, c.navUsd);
        ctx.pubBandUsd = pubBand;
        uint256[3] memory withPrivate = [pubBand[0], pubBand[1], pubBand[2]]; // a copy: memory arrays alias
        withPrivate[ps.band()] += p.navUsd;
        (uint16 cashBps, uint16 equityBps) = _weightsOf(withPrivate, nav);
        if (c.cashBps != cashBps || c.equityBps != equityBps) revert WeightsMismatch(cashBps, equityBps);

        (TreasuryPolicy.Policy memory pol,,) = policy.policyAt(c.policyVersion);
        ctx.policyHash = c.policyHash;
        ctx.bandMin = [pol.cash.minBps, pol.equity.minBps, pol.basis.minBps];
        ctx.bandMax = [pol.cash.maxBps, pol.equity.maxBps, pol.basis.maxBps];
        return ps.checkClose(p, ctx);
    }

    // ---------------------------------------------------------------- views

    /// The pinned book the next `commitSnapshot*` checks against (`takenAt == 0`: none).
    function bookSnapshot() external view returns (BookSnapshot memory) {
        return _snap;
    }

    function latest() external view returns (Close memory c) {
        if (_closes.length != 0) c = _closes[_closes.length - 1];
    }

    function closeAt(uint256 index) external view returns (Close memory) {
        return _closes[index];
    }

    function closeCount() external view returns (uint256) {
        return _closes.length;
    }

    /// Earliest `periodEnd` the next commit accepts, and the policy period it was derived from.
    function nextPeriodEnd() public view returns (uint64) {
        if (_closes.length == 0) return startTime;
        uint64 prev = _closes[_closes.length - 1].periodEnd;
        uint32 v = policy.versionAt(prev);
        (TreasuryPolicy.Policy memory p,,) = policy.policyAt(v);
        return prev + p.periodSeconds;
    }

    function digest(Close calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLOSE_TYPEHASH,
                    c.periodEnd,
                    c.navUsd,
                    c.cashBps,
                    c.equityBps,
                    c.positionsHash,
                    c.bundleHash,
                    c.policyHash,
                    c.policyVersion
                )
            )
        );
    }

    /// What `commit` would recompute right now: the held positions (sorted), their hash, NAV, band weights and
    /// whether a held feed is on hold (`holdToken` = the first one, zero if none). The close service builds its
    /// statement from this and retries if the chain moves before inclusion.
    function preview()
        external
        view
        returns (
            Position[] memory positions,
            bytes32 positionsHash,
            uint256 navUsd,
            uint16 cashBps,
            uint16 equityBps,
            address holdToken
        )
    {
        (positionsHash, positions, holdToken) = _positionsView();
        (navUsd,) = account.navUsd();
        (cashBps, equityBps) = _weightsOf(_bandUsd(), navUsd);
    }

    /// Fee in cash raw units for `navUsd` (1e18) over `elapsed` seconds.
    function feeFor(uint256 navUsd, uint256 elapsed) public view returns (uint256) {
        if (feeRecipient == address(0)) return 0;
        uint256 usd = navUsd * FEE_BPS * elapsed / (BPS * YEAR);
        uint8 dec = cashDecimals;
        if (dec <= 18) return usd / 10 ** (18 - dec);
        return usd * 10 ** (dec - 18);
    }

    // ---------------------------------------------------------------- internal

    function _checkTiming(uint64 periodEnd) private view returns (uint64 prevEnd) {
        if (periodEnd > block.timestamp) revert PeriodInFuture(periodEnd, block.timestamp);
        uint64 earliest = nextPeriodEnd();
        if (periodEnd < earliest) revert PeriodTooEarly(periodEnd, earliest);
        prevEnd = _closes.length == 0 ? startTime : _closes[_closes.length - 1].periodEnd;
    }

    function _checkPolicy(Close calldata c) private view returns (address controller) {
        uint32 v = policy.versionAt(c.periodEnd);
        if (v == 0) revert NoPolicyAt(c.periodEnd);
        (TreasuryPolicy.Policy memory p, bytes32 h,) = policy.policyAt(v);
        if (c.policyVersion != v || c.policyHash != h) revert PolicyMismatch(h, v);
        controller = p.controller;
    }

    /// The period length is the one in force at the period's start (`prevEnd`), as in `nextPeriodEnd`; before
    /// the first policy version it is the one in force at `periodEnd`.
    function _checkTier(uint64 prevEnd, uint64 periodEnd) private view {
        if (address(tiers) == address(0)) return;
        uint32 v = policy.versionAt(prevEnd);
        if (v == 0) v = policy.versionAt(periodEnd);
        (TreasuryPolicy.Policy memory p,,) = policy.policyAt(v);
        if (p.periodSeconds >= WEEKLY_BELOW) return;
        address board = account.board();
        if (!tiers.tierOf(board).weeklyClose) revert TierTooLow(board);
    }

    /// Public cash / equity / basis USD from the sleeves' own `valueOf` (a private sleeve's is 0), plus the
    /// account's loose cash (USDG no registered sleeve lists yet) in the cash band, matching `account.navUsd()`.
    function _bandUsd() private view returns (uint256[3] memory usd) {
        address[] memory sl = account.sleeves();
        for (uint256 i; i < sl.length; ++i) {
            (uint256 v,) = ISleeve(sl[i]).valueOf(address(account));
            uint8 band = ISleeve(sl[i]).band();
            usd[band > 2 ? 2 : band] += v;
        }
        (, uint256 loose) = account.looseCash();
        usd[0] += loose;
    }

    /// A basis sleeve (2) is in NAV but in neither weight.
    function _weightsOf(uint256[3] memory usd, uint256 nav) private pure returns (uint16 cashBps, uint16 equityBps) {
        if (nav == 0) return (0, 0);
        cashBps = uint16(usd[0] * BPS / nav);
        equityBps = uint16(usd[1] * BPS / nav);
    }

    function _positions(bool revertOnHold) private view returns (bytes32 h, address holdToken) {
        (h,, holdToken) = _positionsView();
        if (revertOnHold && holdToken != address(0)) revert HoldAtClose(holdToken);
    }

    function _positionsView() private view returns (bytes32 h, Position[] memory out, address holdToken) {
        (address[] memory assets, uint8[] memory kinds,) = account.trackedAssets();
        Position[] memory tmp = new Position[](assets.length);
        uint256 n;
        for (uint256 i; i < assets.length; ++i) {
            uint256 raw = IERC20(assets[i]).balanceOf(address(account));
            if (raw == 0) continue;
            Position memory p = tmp[n++];
            p.asset = assets[i];
            p.raw = raw;
            p.multiplier = 1e18;
            if (kinds[i] == AssetValuation.KIND_CASH) {
                p.price = 1e18;
            } else if (kinds[i] == AssetValuation.KIND_CASH_VAULT) {
                IERC4626 v = IERC4626(assets[i]);
                uint256 one = 10 ** IERC20Metadata(assets[i]).decimals();
                p.price = AssetValuation.to1e18(v.convertToAssets(one), IERC20Metadata(v.asset()).decimals());
            } else if (valuer.registry().isCanonical(assets[i])) {
                Valuer.Quote memory q = valuer.quote(assets[i]);
                p.price = q.priceUsdPerToken;
                p.multiplier = q.multiplier;
                p.roundId = q.roundId;
                if (q.hold && holdToken == address(0)) holdToken = assets[i];
            } else {
                p.multiplier = 0; // delisted: no trusted price, valued 0 in NAV
            }
        }
        out = new Position[](n);
        for (uint256 i; i < n; ++i) {
            // insertion sort by address (n <= MAX_SLEEVES x MAX_ASSETS_PER_SLEEVE)
            Position memory p = tmp[i];
            uint256 j = i;
            while (j > 0 && out[j - 1].asset > p.asset) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = p;
        }
        h = keccak256(abi.encode(out));
    }

    function _fee(uint256 nav, uint256 elapsed) private returns (uint256 feeRaw, uint256 paid, uint256 owed) {
        if (feeRecipient == address(0)) return (0, 0, 0);
        feeRaw = feeFor(nav, elapsed);
        uint256 due = feeOwed + feeRaw;
        uint256 idle = cash.balanceOf(address(account));
        paid = due < idle ? due : idle;
        owed = due - paid;
        feeOwed = owed;
        if (paid != 0) {
            account.payCloseFee(address(cash), feeRecipient, paid);
            // Tell a contract recipient (the FeeRouter) which treasury paid, so it can carve out the template
            // author's share. Best effort: a recipient without the hook (or one that reverts) never blocks a close.
            if (feeRecipient.code.length != 0) {
                try ICloseFeeHook(feeRecipient).onCloseFee(address(account), paid) {} catch {}
            }
        }
    }
}
