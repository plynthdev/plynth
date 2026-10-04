// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITierSource, Tier} from "./ITierSource.sol";

/// PLTH staking with rewards in two tokens (index 0 = USDG, index 1 = PLTH) and tiers by staked amount.
///
/// Rewards accrue per one-hour bucket so a just-in-time stake earns nothing:
/// - a new stake is `pending` for the rest of the hour it was made in and becomes `active` when the next
///   hour starts;
/// - rewards notified during hour h are queued and distributed when hour h ends, pro rata over the stake that
///   was active for the whole of hour h (stake made during h is still pending; stake unbonded during h left);
/// - so the earliest reward a stake made at any moment of hour h can receive is from rewards notified in h+1,
///   paid out when h+1 ends. Rewards notified while nobody is active stay queued for the next bucket.
/// Unstaking starts a 7-day unbonding; unbonding stake earns nothing and does not count for the tier. A new
/// unstake while one is unbonding adds to it and restarts the 7 days.
///
/// Accounting is reward-per-share (1e36 precision) with floor rounding everywhere, so the contract always
/// holds at least what it owes (the amount taken from the queue is rounded up, shares down); the remainder
/// is carried to the next bucket, never lost.
/// No owner and no admin functions. Anyone may `notifyReward` (the FeeRouter and the PLTH reserve do).
contract PlinthStaking is ITierSource, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TierSpec {
        uint256 minStake; // PLTH (18 dp) at or above which the tier applies
        Tier tier;
    }

    struct Staker {
        uint256 active;
        uint256 pending;
        uint64 pendingBucket;
        uint64 releaseAt;
        uint256 unbonding;
        uint256[2] debt; // acc at the last sync, per reward token
        uint256[2] owed; // claimable, per reward token
    }

    uint256 public constant BUCKET = 1 hours;
    uint256 public constant UNBONDING = 7 days;
    uint256 public constant MAX_TIERS = 8;
    uint256 private constant P = 1e36;

    IERC20 public immutable plth;
    IERC20 public immutable usdg;

    TierSpec[] private _tiers;
    uint64 public lastBucket;
    uint256 public activeSupply;
    uint256 public pendingSupply; // stake made during `lastBucket`
    uint256 public unbondingSupply;
    uint256[2] public queued; // rewards notified during `lastBucket`, not yet distributed
    uint256[2] public acc; // reward per active stake, 1e36-scaled
    mapping(uint64 bucket => uint256[2]) private _accAtActivation; // acc when stake pending in `bucket` activated
    mapping(address => Staker) private _stakers;

    event Staked(address indexed staker, uint256 amount, uint64 activeFromBucket);
    event Unstaked(address indexed staker, uint256 amount, uint64 releaseAt);
    event Withdrawn(address indexed staker, uint256 amount);
    event RewardNotified(address indexed token, address indexed from, uint256 amount, uint64 bucket);
    event BucketRolled(uint64 indexed bucket, uint256 activeSupply, uint256 usdgDistributed, uint256 plthDistributed);
    event Claimed(address indexed staker, uint256 usdgAmount, uint256 plthAmount);

    error ZeroAddress();
    error ZeroAmount();
    error BadTiers();
    error NotRewardToken(address token);
    error InsufficientStake(uint256 have, uint256 want);
    error StillUnbonding(uint64 releaseAt);
    error NothingToWithdraw();

    /// `tiers_` must start at minStake 0 and be strictly ascending in minStake.
    constructor(IERC20 plth_, IERC20 usdg_, TierSpec[] memory tiers_) {
        if (address(plth_) == address(0) || address(usdg_) == address(0)) revert ZeroAddress();
        if (tiers_.length == 0 || tiers_.length > MAX_TIERS || tiers_[0].minStake != 0) revert BadTiers();
        for (uint256 i; i < tiers_.length; ++i) {
            if (i > 0 && tiers_[i].minStake <= tiers_[i - 1].minStake) revert BadTiers();
            _tiers.push(tiers_[i]);
        }
        plth = plth_;
        usdg = usdg_;
        lastBucket = _bucket();
    }

    // ---------------------------------------------------------------- staking

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _roll();
        Staker storage s = _sync(msg.sender);
        plth.safeTransferFrom(msg.sender, address(this), amount);
        s.pending += amount;
        s.pendingBucket = lastBucket;
        pendingSupply += amount;
        emit Staked(msg.sender, amount, lastBucket + 1);
    }

    /// Moves `amount` of stake (pending first, then active) into unbonding for 7 days.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _roll();
        Staker storage s = _sync(msg.sender);
        uint256 have = s.pending + s.active;
        if (amount > have) revert InsufficientStake(have, amount);
        uint256 fromPending = amount < s.pending ? amount : s.pending;
        s.pending -= fromPending;
        pendingSupply -= fromPending;
        uint256 fromActive = amount - fromPending;
        s.active -= fromActive;
        activeSupply -= fromActive;
        s.unbonding += amount;
        unbondingSupply += amount;
        s.releaseAt = uint64(block.timestamp + UNBONDING);
        emit Unstaked(msg.sender, amount, s.releaseAt);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        Staker storage s = _stakers[msg.sender];
        amount = s.unbonding;
        if (amount == 0) revert NothingToWithdraw();
        if (block.timestamp < s.releaseAt) revert StillUnbonding(s.releaseAt);
        s.unbonding = 0;
        unbondingSupply -= amount;
        plth.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 usdgAmount, uint256 plthAmount) {
        _roll();
        Staker storage s = _sync(msg.sender);
        (usdgAmount, plthAmount) = (s.owed[0], s.owed[1]);
        s.owed[0] = 0;
        s.owed[1] = 0;
        if (usdgAmount != 0) usdg.safeTransfer(msg.sender, usdgAmount);
        if (plthAmount != 0) plth.safeTransfer(msg.sender, plthAmount);
        emit Claimed(msg.sender, usdgAmount, plthAmount);
    }

    /// Queues `amount` of USDG or PLTH (pulled from the caller) for the stakers active through this hour.
    function notifyReward(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 k = _index(token);
        _roll();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        queued[k] += amount;
        emit RewardNotified(token, msg.sender, amount, lastBucket);
    }

    /// Distributes the finished bucket's rewards and activates its pending stake. Anyone may call it; every
    /// state-changing function does it first.
    function roll() external {
        _roll();
    }

    // ---------------------------------------------------------------- views

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tierSpec(uint256 i) external view returns (TierSpec memory) {
        return _tiers[i];
    }

    /// Staked = active + pending (unbonding does not count).
    function stakedOf(address staker) public view returns (uint256) {
        Staker storage s = _stakers[staker];
        return s.active + s.pending;
    }

    function tierIndexOf(address staker) public view returns (uint256 i) {
        uint256 amt = stakedOf(staker);
        i = _tiers.length - 1;
        while (_tiers[i].minStake > amt) --i; // tiers[0].minStake == 0 ends the loop
    }

    function tierOf(address staker) external view returns (Tier memory) {
        return _tiers[tierIndexOf(staker)].tier;
    }

    function stakerOf(address staker)
        external
        view
        returns (uint256 active, uint256 pending, uint256 unbonding, uint64 releaseAt)
    {
        Staker storage s = _stakers[staker];
        bool activated = s.pending != 0 && s.pendingBucket < _bucket();
        active = activated ? s.active + s.pending : s.active;
        pending = activated ? 0 : s.pending;
        (unbonding, releaseAt) = (s.unbonding, s.releaseAt);
    }

    /// Claimable now (as `claim` would pay after rolling), per reward token: [USDG, PLTH].
    function earned(address staker) external view returns (uint256[2] memory out) {
        (uint256[2] memory a, uint256[2] memory activation, uint64 b) = _rolledView();
        Staker storage s = _stakers[staker];
        for (uint256 k; k < 2; ++k) {
            out[k] = s.owed[k] + s.active * (a[k] - s.debt[k]) / P;
            if (s.pending != 0 && s.pendingBucket < b) {
                uint256 at = s.pendingBucket == lastBucket ? activation[k] : _accAtActivation[s.pendingBucket][k];
                out[k] += s.pending * (a[k] - at) / P;
            }
        }
    }

    // ---------------------------------------------------------------- internal

    function _bucket() private view returns (uint64) {
        return uint64(block.timestamp / BUCKET);
    }

    function _index(address token) private view returns (uint256) {
        if (token == address(usdg)) return 0;
        if (token == address(plth)) return 1;
        revert NotRewardToken(token);
    }

    function _roll() private {
        uint64 b = _bucket();
        uint64 last = lastBucket;
        if (b == last) return;
        // 1. rewards notified during `last` go to the stake active through all of `last`
        uint256[2] memory dist = _distribute(activeSupply);
        _accAtActivation[last] = acc;
        emit BucketRolled(last, activeSupply, dist[0], dist[1]);
        // 2. stake made during `last` is active from `last + 1`
        uint256 supply = activeSupply + pendingSupply;
        activeSupply = supply;
        pendingSupply = 0;
        // 3. if `last + 1` has also ended, nothing was notified in it: what is still queued (carried while
        //    nobody was active) goes to the stake active through it
        if (b > last + 1) {
            dist = _distribute(supply);
            emit BucketRolled(last + 1, supply, dist[0], dist[1]);
        }
        lastBucket = b;
    }

    /// Moves `queued` into `acc` over `supply`. The amount taken from `queued` is rounded UP and each staker's
    /// share is rounded down, so the sum of all claims never exceeds what was notified.
    function _distribute(uint256 supply) private returns (uint256[2] memory dist) {
        if (supply == 0) return dist;
        for (uint256 k; k < 2; ++k) {
            uint256 q = queued[k];
            if (q == 0) continue;
            uint256 inc = q * P / supply;
            if (inc == 0) continue;
            acc[k] += inc;
            dist[k] = Math.mulDiv(inc, supply, P, Math.Rounding.Ceil); // <= q
            queued[k] = q - dist[k];
        }
    }

    /// Settles `who`'s rewards up to the current acc and activates their pending stake if its bucket ended.
    /// Must run after `_roll`.
    function _sync(address who) private returns (Staker storage s) {
        s = _stakers[who];
        uint256[2] memory a = acc;
        bool activate = s.pending != 0 && s.pendingBucket < lastBucket;
        for (uint256 k; k < 2; ++k) {
            uint256 add = s.active * (a[k] - s.debt[k]) / P;
            if (activate) add += s.pending * (a[k] - _accAtActivation[s.pendingBucket][k]) / P;
            s.owed[k] += add;
            s.debt[k] = a[k];
        }
        if (activate) {
            s.active += s.pending;
            s.pending = 0;
        }
    }

    /// acc as `_roll` would leave it, the activation acc it would record for `lastBucket`, and the bucket.
    function _rolledView() private view returns (uint256[2] memory a, uint256[2] memory activation, uint64 b) {
        a = acc;
        b = _bucket();
        if (b == lastBucket) return (a, a, b);
        uint256[2] memory q = queued;
        _distributeView(a, q, activeSupply);
        activation = [a[0], a[1]];
        if (b > lastBucket + 1) _distributeView(a, q, activeSupply + pendingSupply);
    }

    function _distributeView(uint256[2] memory a, uint256[2] memory q, uint256 supply) private pure {
        if (supply == 0) return;
        for (uint256 k; k < 2; ++k) {
            uint256 inc = q[k] * P / supply;
            if (inc == 0) continue;
            a[k] += inc;
            q[k] -= Math.mulDiv(inc, supply, P, Math.Rounding.Ceil);
        }
    }
}
