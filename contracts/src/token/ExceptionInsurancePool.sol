// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TreasuryAccount} from "../treasury/TreasuryAccount.sol";
import {TreasuryPolicy} from "../treasury/TreasuryPolicy.sol";

/// USDG pool that covers a treasury's loss caused by a policy bug (the guard let through something the
/// policy should have stopped), never a market move.
///
/// A claim is filed by the treasury's board and pays only when BOTH
///   - the insurance committee (a Safe) approves it, and
///   - the treasury's controller (the policy's `controller`, the key that signs period closes) attests it is
///     a policy-bug loss. An attestation of "market move" rejects the claim.
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
/// withdrawer's exit cannot move the active share price. Deposits are refused while a claim is owed or while
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
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdg;
    uint8 public immutable usdgDecimals;
    address public immutable committee;
    address public immutable deployer;
    /// The only caller of `depositFees` and where an ownerless active surplus goes. Bound once by the deployer.
    address public feeRouter;

    Claim[] private _claims;
    uint256[] private _queue;
    uint256 public queueHead;
    uint256 public queuedOwed; // unpaid remainder of queued claims

    uint256 public activeShares;
    mapping(address => uint256) public sharesOf;

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

    constructor(IERC20Metadata usdg_, address committee_, uint256 withdrawDelay_) {
        if (withdrawDelay_ < MIN_WITHDRAW_DELAY) revert DelayTooShort();
        WITHDRAW_DELAY = withdrawDelay_;
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

    // ---------------------------------------------------------------- claims

    /// `lossUsd` is 1e18-scaled USD; it is paid in USDG at 1:1.
    function fileClaim(TreasuryAccount treasury, uint256 lossUsd, bytes32 evidenceHash)
        external
        returns (uint256 id)
    {
        if (msg.sender != treasury.board()) revert NotBoard();
        uint256 amount = _toRaw(lossUsd);
        if (amount == 0) revert ZeroAmount();
        id = _claims.length;
        _claims.push(
            Claim(address(treasury), msg.sender, amount, 0, evidenceHash, uint64(block.timestamp), false, false, Status.Filed)
        );
        emit ClaimFiled(id, address(treasury), msg.sender, amount, evidenceHash);
    }

    function approveClaim(uint256 id) external {
        if (msg.sender != committee) revert NotCommittee();
        Claim storage c = _filed(id);
        if (c.committeeApproved) revert AlreadyDone();
        c.committeeApproved = true;
        emit ClaimApproved(id);
        _maybeQueue(id, c);
    }

    function rejectClaim(uint256 id) external {
        if (msg.sender != committee) revert NotCommittee();
        _filed(id).status = Status.Rejected;
        emit ClaimRejected(id, msg.sender);
    }

    /// Called by the controller of the treasury's policy in force now. `policyBug = false` (a market move)
    /// rejects the claim.
    function attest(uint256 id, bool policyBug) external {
        Claim storage c = _filed(id);
        (TreasuryPolicy.Policy memory p,,) = TreasuryAccount(c.treasury).policy().current();
        if (msg.sender != p.controller) revert NotController();
        if (c.policyBugAttested) revert AlreadyDone();
        emit ClaimAttested(id, msg.sender, policyBug);
        if (!policyBug) {
            c.status = Status.Rejected;
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
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit FeesDeposited(msg.sender, amount);
        _process();
        _returnIdle();
    }

    /// Refused while a queued claim is unpaid, or while active shares are worth under MIN_PRICE_BPS of the
    /// entry price (see the contract notes).
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (queuedOwed != 0) revert ClaimsOwed();
        _returnIdle(); // with no active share, whatever the active side holds is not the newcomer's
        uint256 a = activeAssets();
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

    /// Balance not owed to queued claims.
    function freeAssets() public view returns (uint256) {
        uint256 bal = usdg.balanceOf(address(this));
        return bal > queuedOwed ? bal - queuedOwed : 0;
    }

    /// What the active shares own: free assets less the withdrawing LPs' liability.
    function activeAssets() public view returns (uint256) {
        uint256 f = freeAssets();
        return f > pendingAssets ? f - pendingAssets : 0;
    }

    /// Value of `shares` active shares now.
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
        uint256 a = activeAssets();
        if (a == 0) return;
        usdg.safeTransfer(to, a);
        emit SurplusReturned(to, a);
    }

    function _toRaw(uint256 usd) private view returns (uint256) {
        uint8 d = usdgDecimals;
        return d <= 18 ? usd / 10 ** (18 - d) : usd * 10 ** (d - 18);
    }
}
