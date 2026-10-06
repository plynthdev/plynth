// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
/// Money in: fees from the FeeRouter (`depositFees`, no shares, raises the share value) and optional LP
/// deposits (`deposit`, shares). LPs bear the claims. Withdrawing is two steps with a 14-day delay; shares
/// waiting to withdraw still bear claims, so an LP cannot see a claim coming and leave first. Share value
/// counts only assets not owed to queued claims. Virtual shares (1e6) make the first-depositor inflation
/// trick unprofitable. No owner; the committee can only approve or reject claims.
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

    uint256 public constant WITHDRAW_DELAY = 14 days;
    uint256 public constant MAX_PROCESS = 16;
    uint256 private constant VIRTUAL_SHARES = 1e6;

    IERC20 public immutable usdg;
    uint8 public immutable usdgDecimals;
    address public immutable committee;

    Claim[] private _claims;
    uint256[] private _queue;
    uint256 public queueHead;
    uint256 public queuedOwed; // unpaid remainder of queued claims

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public withdrawingOf;
    mapping(address => uint64) public withdrawReadyAt;

    event ClaimFiled(uint256 indexed id, address indexed treasury, address indexed board, uint256 amount, bytes32 evidenceHash);
    event ClaimApproved(uint256 indexed id);
    event ClaimAttested(uint256 indexed id, address indexed controller, bool policyBug);
    event ClaimRejected(uint256 indexed id, address by);
    event ClaimQueued(uint256 indexed id, uint256 position);
    event ClaimPaid(uint256 indexed id, uint256 amount, uint256 totalPaid, bool done);
    event FeesDeposited(address indexed from, uint256 amount);
    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed lp, uint256 shares, uint64 readyAt);
    event Withdrawn(address indexed lp, uint256 shares, uint256 assets);

    error ZeroAddress();
    error ZeroAmount();
    error NotBoard();
    error NotCommittee();
    error NotController();
    error BadStatus(Status status);
    error AlreadyDone();
    error InsufficientShares();
    error NotReady(uint64 readyAt);
    error ClaimsOwed();

    constructor(IERC20Metadata usdg_, address committee_) {
        if (address(usdg_) == address(0) || committee_ == address(0)) revert ZeroAddress();
        usdg = IERC20(address(usdg_));
        usdgDecimals = usdg_.decimals();
        committee = committee_;
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
    }

    // ---------------------------------------------------------------- money in / LPs

    function depositFees(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit FeesDeposited(msg.sender, amount);
        _process();
    }

    /// Refused while any queued claim is unpaid, or while existing shares are worth nothing (a claim took
    /// the whole pool): in both states the share price is 0 or near it, so a tiny deposit would mint almost
    /// every share and take the existing LPs' claim on all later fees. Fees reopen deposits.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (queuedOwed != 0 || (totalShares != 0 && freeAssets() == 0)) revert ClaimsOwed();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (freeAssets() + 1);
        if (shares == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), assets);
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, assets, shares);
        _process();
    }

    /// Locks `shares` for WITHDRAW_DELAY (restarted by every new request). Locked shares still bear claims.
    function requestWithdraw(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();
        sharesOf[msg.sender] -= shares;
        withdrawingOf[msg.sender] += shares;
        uint64 readyAt = uint64(block.timestamp + WITHDRAW_DELAY);
        withdrawReadyAt[msg.sender] = readyAt;
        emit WithdrawRequested(msg.sender, shares, readyAt);
    }

    function withdraw() external nonReentrant returns (uint256 assets) {
        uint256 shares = withdrawingOf[msg.sender];
        if (shares == 0) revert ZeroAmount();
        uint64 readyAt = withdrawReadyAt[msg.sender];
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        assets = previewRedeem(shares);
        withdrawingOf[msg.sender] = 0;
        totalShares -= shares;
        usdg.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, shares, assets);
    }

    // ---------------------------------------------------------------- views

    /// Balance not owed to queued claims.
    function freeAssets() public view returns (uint256) {
        uint256 bal = usdg.balanceOf(address(this));
        return bal > queuedOwed ? bal - queuedOwed : 0;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return shares * (freeAssets() + 1) / (totalShares + VIRTUAL_SHARES);
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
        queuedOwed += c.amount;
        emit ClaimQueued(id, _queue.length - 1 - queueHead);
        _process();
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

    function _toRaw(uint256 usd) private view returns (uint256) {
        uint8 d = usdgDecimals;
        return d <= 18 ? usd / 10 ** (18 - d) : usd * 10 ** (d - 18);
    }
}
