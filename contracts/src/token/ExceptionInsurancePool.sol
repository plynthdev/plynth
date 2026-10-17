// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TreasuryAccount} from "../treasury/TreasuryAccount.sol";
import {TreasuryPolicy} from "../treasury/TreasuryPolicy.sol";

/// The part of the TreasuryFactory the pool reads: only treasuries it made may claim.
interface ITreasuryRegistry {
    function isTreasury(address account) external view returns (bool);
    /// The account a PeriodClose was made for (zero if the factory did not make it).
    function accountOfClose(address close) external view returns (address);
}

/// The part of a PeriodClose the pool reads: the period-start NAV and how many periods have closed.
interface IPeriodCloseCap {
    function periodStartNav() external view returns (uint256);
    function closeCount() external view returns (uint256);
}

/// USDG pool that covers a treasury's loss caused by a policy bug (the guard let through something the
/// policy should have stopped), never a market move.
///
/// A claim is filed by the treasury's board and pays only when BOTH
///   - the insurance committee (a Safe) approves it, no earlier than REVIEW_DELAY after filing, and
///   - the treasury's controller (the policy's `controller`, the key that signs period closes) attests it is
///     a policy-bug loss. An attestation of "market move" rejects the claim.
/// The controller is appointed by the board itself, so its attestation is NOT an independent check (audit L-7):
/// it can only reject (a controller may veto its own board's claim). The committee's approval is the independent
/// check, and three on-chain limits bound what one wrong approval can cost:
///   - only treasuries the TreasuryFactory made (`isTreasury`) may file (the factory is bound once by the
///     deployer; unbound, every claim is refused), so `board()`, `policy()` and the NAV below are real;
///   - the claims of one treasury filed in one period may not exceed, together, MAX_CLAIM_NAV_BPS of the
///     period-start NAV of the PeriodClose the factory made for it (review-v2 L-11). Live NAV is not used: the
///     board can raise it at once (a sleeve of its own via `registerDesk`), and a swapped-in PeriodClose is not
///     the factory's, so its NAV is refused (cap 0). The period-start NAV comes from a controller-signed close that
///     matched the live book at commit, at most once per period and paying the close fee on it. The running total
///     (`claimedInPeriod`) is keyed by the close count, so one loss cannot be split into many capped claims; a
///     rejected claim gives its amount back to its period. Until the first close the cap is 0;
///   - the committee cannot approve before REVIEW_DELAY has passed since filing, so the claim and its evidence
///     hash are public for that long first.
/// Approved claims join a FIFO queue. A payout never exceeds the pool's balance: the head claim is paid as
/// far as the balance allows and stays at the head until paid in full; later claims wait behind it.
/// Payouts go to the TreasuryAccount itself, not to the board.
///
/// LP accounting. The free balance (`freeAssets`: balance not owed to queued claims) has two owners:
///   - ACTIVE LPs hold shares, priced against `activeAssets()` = freeAssets - pendingAssets only. Fees from
///     the FeeRouter (`depositFees`, router-only) raise only this side.
///   - WITHDRAWING LPs (`requestWithdraw`, 14-day delay) hold no shares. Their shares were burnt at the
///     request for their value at that moment, which moved into `pendingAssets`: a fixed liability that earns
///     nothing but still bears claims (a claim scales active and pending value down by the same factor), so
///     an LP cannot see a claim coming and leave first. A withdrawal pays min(value at request, value at
///     withdraw): the request value less any later claim losses.
/// So a deposit is priced on what the active shares own, never on fees meant for someone else, and a
/// withdrawer's exit cannot move the active share price.
///
/// Fee vesting (audit L-8, the warm-up): router fees that reach the active side do not raise the share price at
/// once; they vest linearly over FEE_VESTING (= WITHDRAW_DELAY; a new fee restarts the clock for what is still
/// unvested). Withdrawal requests and `previewRedeem` count vested assets only, while deposits pay for the
/// unvested fees too (they buy at the full active value). A deposit made just before a fee and withdrawn just
/// after it gains ~0: it either stays exposed to claims for the whole vesting period or leaves its share of the
/// unvested fees to the LPs who stay. Claims scale unvested fees like everything else; with no active share left,
/// unvested fees go back to the FeeRouter with the rest. Deposits are refused while a claim is owed or while
/// the active share price is under MIN_PRICE_BPS of the entry price (1 raw unit per 1e6 shares): a near-zero
/// price would let a newcomer buy almost every share, and with it the old LPs' claim on the fees that should
/// restore them. Only router fees (or claims ending) lift the price back.
/// When no active share is left, whatever the active side still holds (fees that arrived meanwhile, rounding
/// dust, a donation) has no owner: it goes back to the FeeRouter (stakers / buyback), never to the virtual
/// shares. Virtual shares (1e6) make the first-depositor inflation trick unprofitable. No owner; the deployer
/// binds the FeeRouter once; the committee can only approve or reject claims.
contract ExceptionInsurancePool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Filed,
        Queued,
        Paid,
        Rejected
    }

    struct Claim {
        address treasury;
        address board;
        uint256 amount; // USDG raw units
        uint256 paid;
        bytes32 evidenceHash;
        uint64 filedAt;
        bool committeeApproved;
        bool policyBugAttested;
        Status status;
    }

    /// One LP's withdrawal: units of the pending bucket of epoch `epoch` (a claim that wipes the bucket out
    /// starts a new epoch, and units of an older one are worth nothing).
    struct Pending {
        uint256 units;
        uint256 requested; // value at request (sum over requests)
        uint64 epoch;
        uint64 readyAt;
    }

    /// Hard floor for the deploy-time WITHDRAW_DELAY (mainnet/fork 14 days, testnet 15 minutes).
    uint256 public constant MIN_WITHDRAW_DELAY = 10 minutes;
    uint256 public immutable WITHDRAW_DELAY;
    uint256 public constant MAX_PROCESS = 16;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    /// Deposits need active shares worth at least this share of the entry price (1 raw unit per 1e6 shares).
    uint256 public constant MIN_PRICE_BPS = 5_000;
    /// Most the claims of one treasury in one period may ask together, in bps of its period-start NAV.
    uint256 public constant MAX_CLAIM_NAV_BPS = 2_500;
    /// Minimum public review time between filing and committee approval: 3 days, or WITHDRAW_DELAY if shorter.
    uint256 public immutable REVIEW_DELAY;
    /// Router fees vest into the active share price over this long (= WITHDRAW_DELAY).
    uint256 public immutable FEE_VESTING;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdg;
    uint8 public immutable usdgDecimals;
    address public immutable committee;
    address public immutable deployer;
    /// The only caller of `depositFees` and where an ownerless active surplus goes. Bound once by the deployer.
    address public feeRouter;
    /// The TreasuryFactory whose treasuries may claim. Bound once by the deployer; zero = no claims.
    address public treasuryFactory;

    Claim[] private _claims;
    uint256[] private _queue;
    /// USD (1e18) filed and not rejected, per treasury, per period (the PeriodClose's close count at filing).
    mapping(address treasury => mapping(uint256 period => uint256 usd)) public claimedInPeriod;
    mapping(uint256 id => uint256 period) private _periodOf;
    mapping(uint256 id => uint256 usd) private _usdOf;
    uint256 public queueHead;
    uint256 public queuedOwed; // unpaid remainder of queued claims

    uint256 public activeShares;
    mapping(address => uint256) public sharesOf;

    uint256 public lockedFees; // fees still vesting at `lockedAt` (scaled by claims since)
    uint64 public lockedAt;
    uint64 public unlockAt;

    uint256 public pendingAssets; // what the withdrawing LPs are owed now (<= freeAssets)
    uint256 public pendingUnits;
    uint64 public pendingEpoch;
    mapping(address => Pending) private _pending;

    event ClaimFiled(uint256 indexed id, address indexed treasury, address indexed board, uint256 amount, bytes32 evidenceHash);
    event ClaimApproved(uint256 indexed id);
    event ClaimAttested(uint256 indexed id, address indexed controller, bool policyBug);
    event ClaimRejected(uint256 indexed id, address by);
    event ClaimQueued(uint256 indexed id, uint256 position);
    event ClaimPaid(uint256 indexed id, uint256 amount, uint256 totalPaid, bool done);
    event FeeRouterBound(address feeRouter);
    event TreasuryFactoryBound(address treasuryFactory);
    event FeesDeposited(address indexed from, uint256 amount);
    event SurplusReturned(address indexed to, uint256 amount);
    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed lp, uint256 shares, uint256 value, uint64 readyAt);
    event Withdrawn(address indexed lp, uint256 assets);

    error ZeroAddress();
    error ZeroAmount();
    error NotBoard();
    error NotCommittee();
    error NotController();
    error NotDeployer();
    error NotFeeRouter();
    error BadStatus(Status status);
    error AlreadyDone();
    error InsufficientShares();
    error NotReady(uint64 readyAt);
    error ClaimsOwed();
    error SharesUnderwater();
    error DelayTooShort();
    error NotATreasury(address treasury);
    error ClaimTooLarge(uint256 capUsd);
    error InReview(uint64 approvableAt);

    constructor(IERC20Metadata usdg_, address committee_, uint256 withdrawDelay_) {
        if (withdrawDelay_ < MIN_WITHDRAW_DELAY) revert DelayTooShort();
        WITHDRAW_DELAY = withdrawDelay_;
        REVIEW_DELAY = withdrawDelay_ < 3 days ? withdrawDelay_ : 3 days;
        FEE_VESTING = withdrawDelay_;
        if (address(usdg_) == address(0) || committee_ == address(0)) revert ZeroAddress();
        usdg = IERC20(address(usdg_));
        usdgDecimals = usdg_.decimals();
        committee = committee_;
        deployer = msg.sender;
    }

    /// One-time wiring (the FeeRouter is deployed after this pool, with this pool as an immutable).
    function bindFeeRouter(address feeRouter_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (feeRouter != address(0)) revert AlreadyDone();
        if (feeRouter_ == address(0)) revert ZeroAddress();
        feeRouter = feeRouter_;
        emit FeeRouterBound(feeRouter_);
    }

    /// One-time wiring: the TreasuryFactory whose treasuries may file claims.
    function bindTreasuryFactory(address factory_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (treasuryFactory != address(0)) revert AlreadyDone();
        if (factory_ == address(0)) revert ZeroAddress();
        treasuryFactory = factory_;
        emit TreasuryFactoryBound(factory_);
    }

    // ---------------------------------------------------------------- claims

    /// `lossUsd` is 1e18-scaled USD; it is paid in USDG at 1:1. Only a TreasuryFactory treasury's board, and at
    /// most what is left of this period's cap (`claimCapUsd`).
    function fileClaim(TreasuryAccount treasury, uint256 lossUsd, bytes32 evidenceHash)
        external
        returns (uint256 id)
    {
        address f = treasuryFactory;
        if (f == address(0) || !ITreasuryRegistry(f).isTreasury(address(treasury))) {
            revert NotATreasury(address(treasury));
        }
        if (msg.sender != treasury.board()) revert NotBoard();
        (uint256 capLeft, uint256 period) = _capLeft(treasury);
        if (lossUsd > capLeft) revert ClaimTooLarge(capLeft);
        uint256 amount = _toRaw(lossUsd);
        if (amount == 0) revert ZeroAmount();
        id = _claims.length;
        claimedInPeriod[address(treasury)][period] += lossUsd;
        _periodOf[id] = period;
        _usdOf[id] = lossUsd;
        _claims.push(
            Claim(address(treasury), msg.sender, amount, 0, evidenceHash, uint64(block.timestamp), false, false, Status.Filed)
        );
        emit ClaimFiled(id, address(treasury), msg.sender, amount, evidenceHash);
    }

    /// The committee, no earlier than REVIEW_DELAY after filing.
    function approveClaim(uint256 id) external {
        if (msg.sender != committee) revert NotCommittee();
        Claim storage c = _filed(id);
        if (c.committeeApproved) revert AlreadyDone();
        uint64 at = uint64(c.filedAt + REVIEW_DELAY);
        if (block.timestamp < at) revert InReview(at);
        c.committeeApproved = true;
        emit ClaimApproved(id);
        _maybeQueue(id, c);
    }

    function rejectClaim(uint256 id) external {
        if (msg.sender != committee) revert NotCommittee();
        Claim storage c = _filed(id);
        c.status = Status.Rejected;
        _release(id, c);
        emit ClaimRejected(id, msg.sender);
    }

    /// Called by the controller of the treasury's policy in force now. `policyBug = false` (a market move)
    /// rejects the claim. Not independent of the board (it appoints the controller): see the contract notes.
    function attest(uint256 id, bool policyBug) external {
        Claim storage c = _filed(id);
        (TreasuryPolicy.Policy memory p,,) = TreasuryAccount(c.treasury).policy().current();
        if (msg.sender != p.controller) revert NotController();
        if (c.policyBugAttested) revert AlreadyDone();
        emit ClaimAttested(id, msg.sender, policyBug);
        if (!policyBug) {
            c.status = Status.Rejected;
            _release(id, c);
            emit ClaimRejected(id, msg.sender);
            return;
        }
        c.policyBugAttested = true;
        _maybeQueue(id, c);
    }

    /// Pays queued claims in order, as far as the balance allows (at most MAX_PROCESS claims per call).
    function processQueue() external nonReentrant {
        _process();
        _returnIdle();
    }

    // ---------------------------------------------------------------- money in / LPs

    /// Router-only: a public entry let anyone lift a near-zero share price by 1 wei and reopen deposits.
    /// Fees pay owed claims first; the rest raises the active share price (or, with no active share, goes
    /// straight back to the router).
    function depositFees(uint256 amount) external nonReentrant {
        if (msg.sender != feeRouter) revert NotFeeRouter();
        if (amount == 0) revert ZeroAmount();
        uint256 freeBefore = freeAssets();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit FeesDeposited(msg.sender, amount);
        _process();
        uint256 freeAfter = freeAssets();
        // What reached the free side (after owed claims) vests into the active share price over FEE_VESTING.
        if (activeShares != 0 && freeAfter > freeBefore) {
            lockedFees = unvestedFees() + (freeAfter - freeBefore);
            lockedAt = uint64(block.timestamp);
            unlockAt = uint64(block.timestamp + FEE_VESTING);
        }
        _returnIdle();
    }

    /// Refused while a queued claim is unpaid, or while active shares are worth under MIN_PRICE_BPS of the
    /// entry price (see the contract notes).
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (queuedOwed != 0) revert ClaimsOwed();
        _returnIdle(); // with no active share, whatever the active side holds is not the newcomer's
        uint256 a = _activeFull(); // a newcomer pays for the unvested fees too: they are the stayers'
        uint256 s = activeShares;
        if (s != 0 && (a + 1) * VIRTUAL_SHARES * BPS < (s + VIRTUAL_SHARES) * MIN_PRICE_BPS) revert SharesUnderwater();
        shares = Math.mulDiv(assets, s + VIRTUAL_SHARES, a + 1);
        if (shares == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), assets);
        sharesOf[msg.sender] += shares;
        activeShares = s + shares;
        emit Deposited(msg.sender, assets, shares);
        _process();
    }

    /// Burns `shares` for their value now, which becomes a fixed liability payable after WITHDRAW_DELAY
    /// (restarted by every new request). It earns nothing from here on and still bears claims.
    function requestWithdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();
        uint256 value = previewRedeem(shares);
        sharesOf[msg.sender] -= shares;
        activeShares -= shares;
        if (value == 0) {
            // shares a claim made worthless: they just leave (otherwise they could never exit, and the dust
            // under them could never go back to the router)
            emit WithdrawRequested(msg.sender, shares, 0, 0);
            _returnIdle();
            return;
        }

        Pending storage p = _pending[msg.sender];
        if (p.epoch != pendingEpoch) (p.units, p.requested) = (0, 0); // an older request a claim wiped out
        uint256 units = pendingUnits == 0 ? value : Math.mulDiv(value, pendingUnits, pendingAssets);
        pendingUnits += units;
        pendingAssets += value;
        p.units += units;
        p.requested += value;
        p.epoch = pendingEpoch;
        uint64 readyAt = uint64(block.timestamp + WITHDRAW_DELAY);
        p.readyAt = readyAt;
        emit WithdrawRequested(msg.sender, shares, value, readyAt);
        _returnIdle(); // the last active LP left: the virtual shares' slice is nobody's
    }

    function withdraw() external nonReentrant returns (uint256 assets) {
        Pending memory p = _pending[msg.sender];
        if (p.units == 0) revert ZeroAmount();
        if (block.timestamp < p.readyAt) revert NotReady(p.readyAt);
        delete _pending[msg.sender];
        if (p.epoch == pendingEpoch) {
            assets = Math.mulDiv(p.units, pendingAssets, pendingUnits);
            if (assets > p.requested) assets = p.requested; // others' rounding dust is not this LP's
            pendingUnits -= p.units;
            pendingAssets = pendingUnits == 0 ? 0 : pendingAssets - assets; // last one out: dust to the active side
        }
        if (assets != 0) usdg.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets);
        _returnIdle();
    }

    /// Sends the active side's assets back to the FeeRouter when no active share is left (also done by every
    /// LP action); callable by anyone so nothing can sit ownerless.
    function returnIdle() external nonReentrant {
        _returnIdle();
    }

    // ---------------------------------------------------------------- views

    /// What the claims of `treasury` may still ask this period (USD 1e18): MAX_CLAIM_NAV_BPS of the period-start
    /// NAV of the PeriodClose the factory made for it, less what was already filed (and not rejected) this period.
    /// 0 if its PeriodClose is not the factory's own, or before its first close.
    function claimCapUsd(TreasuryAccount treasury) public view returns (uint256 left) {
        (left,) = _capLeft(treasury);
    }

    function _capLeft(TreasuryAccount treasury) private view returns (uint256 left, uint256 period) {
        address pc = treasury.periodClose();
        address f = treasuryFactory;
        if (pc == address(0) || f == address(0) || ITreasuryRegistry(f).accountOfClose(pc) != address(treasury)) {
            return (0, 0);
        }
        period = IPeriodCloseCap(pc).closeCount();
        uint256 cap = IPeriodCloseCap(pc).periodStartNav() * MAX_CLAIM_NAV_BPS / BPS;
        uint256 used = claimedInPeriod[address(treasury)][period];
        left = cap > used ? cap - used : 0;
    }

    /// Balance not owed to queued claims.
    function freeAssets() public view returns (uint256) {
        uint256 bal = usdg.balanceOf(address(this));
        return bal > queuedOwed ? bal - queuedOwed : 0;
    }

    /// What the active shares own and has vested: free assets less the withdrawing LPs' liability and the
    /// unvested fees.
    function activeAssets() public view returns (uint256) {
        uint256 a = _activeFull();
        uint256 u = unvestedFees();
        return a > u ? a - u : 0;
    }

    /// Router fees still vesting into the active side (linear from `lockedAt` to `unlockAt`).
    function unvestedFees() public view returns (uint256) {
        uint256 end = unlockAt;
        if (block.timestamp >= end) return 0;
        return Math.mulDiv(lockedFees, end - block.timestamp, end - lockedAt);
    }

    /// Value of `shares` active shares now (vested assets only: what a withdrawal request locks in).
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, activeAssets() + 1, activeShares + VIRTUAL_SHARES);
    }

    /// What `lp`'s withdrawal would pay now (0 if a claim wiped it out).
    function pendingValueOf(address lp) public view returns (uint256) {
        Pending memory p = _pending[lp];
        if (p.units == 0 || p.epoch != pendingEpoch) return 0;
        return Math.min(Math.mulDiv(p.units, pendingAssets, pendingUnits), p.requested);
    }

    /// `lp`'s withdrawal: value at request (sum over requests), value now, and when it can be withdrawn.
    function pendingOf(address lp) external view returns (uint256 requested, uint256 value, uint64 readyAt) {
        Pending memory p = _pending[lp];
        return (p.requested, pendingValueOf(lp), p.readyAt);
    }

    function claim(uint256 id) external view returns (Claim memory) {
        return _claims[id];
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    function queueLength() external view returns (uint256) {
        return _queue.length - queueHead;
    }

    function queueAt(uint256 i) external view returns (uint256) {
        return _queue[queueHead + i];
    }

    // ---------------------------------------------------------------- internal

    /// A rejected claim gives its amount back to the period it was filed in.
    function _release(uint256 id, Claim storage c) private {
        uint256 usd = _usdOf[id];
        delete _usdOf[id];
        claimedInPeriod[c.treasury][_periodOf[id]] -= usd;
    }

    function _filed(uint256 id) private view returns (Claim storage c) {
        c = _claims[id];
        if (c.status != Status.Filed) revert BadStatus(c.status);
    }

    function _maybeQueue(uint256 id, Claim storage c) private {
        if (!(c.committeeApproved && c.policyBugAttested)) return;
        c.status = Status.Queued;
        _queue.push(id);
        uint256 before = freeAssets();
        queuedOwed += c.amount;
        _absorbLoss(before, freeAssets());
        emit ClaimQueued(id, _queue.length - 1 - queueHead);
        _process();
    }

    /// A queued claim cut the free assets from `before` to `afterLoss`: the withdrawing LPs lose the same
    /// fraction as the active ones (the active side gets the rounding).
    function _absorbLoss(uint256 before, uint256 afterLoss) private {
        if (lockedFees != 0) lockedFees = before == 0 ? 0 : Math.mulDiv(lockedFees, afterLoss, before);
        uint256 p = pendingAssets;
        if (p == 0) return;
        p = Math.mulDiv(p, afterLoss, before); // before >= pendingAssets > 0
        pendingAssets = p;
        if (p == 0) {
            pendingUnits = 0; // every pending withdrawal is worth nothing; later requests start a new bucket
            ++pendingEpoch;
        }
    }

    function _process() private {
        for (uint256 n; n < MAX_PROCESS && queueHead < _queue.length; ++n) {
            uint256 id = _queue[queueHead];
            Claim storage c = _claims[id];
            uint256 remaining = c.amount - c.paid;
            uint256 bal = usdg.balanceOf(address(this));
            uint256 pay = remaining < bal ? remaining : bal;
            if (pay == 0) return;
            c.paid += pay;
            queuedOwed -= pay;
            bool done = c.paid == c.amount;
            if (done) {
                c.status = Status.Paid;
                ++queueHead;
            }
            usdg.safeTransfer(c.treasury, pay);
            emit ClaimPaid(id, pay, c.paid, done);
            if (!done) return;
        }
    }

    function _returnIdle() private {
        if (activeShares != 0) return;
        address to = feeRouter;
        if (to == address(0)) return;
        uint256 a = _activeFull(); // unvested fees included: no share is left to vest them to
        lockedFees = 0;
        if (a == 0) return;
        usdg.safeTransfer(to, a);
        emit SurplusReturned(to, a);
    }

    /// Free assets less the withdrawing LPs' liability, vested or not.
    function _activeFull() private view returns (uint256) {
        uint256 f = freeAssets();
        return f > pendingAssets ? f - pendingAssets : 0;
    }

    function _toRaw(uint256 usd) private view returns (uint256) {
        uint8 d = usdgDecimals;
        return d <= 18 ? usd / 10 ** (18 - d) : usd * 10 ** (d - 18);
    }
}
