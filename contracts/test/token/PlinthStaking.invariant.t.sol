// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {MockERC20} from "../mocks/MockV4.sol";
import {TokenFixture} from "./TokenFixture.sol";

/// Random staking traffic from four stakers plus USDG and PLTH reward funding and time jumps (hours to days,
/// so both the one-hour buckets and the 7-day unbonding are crossed). Every action is bounded so it never
/// reverts unexpectedly (the suite runs with fail-on-revert); actions that MUST revert are checked with
/// try/catch and recorded as violations if they succeed.
contract StakingHandler is Test {
    PlinthStaking immutable staking;
    IERC20 immutable plth;
    MockERC20 immutable usdg;

    address[4] public actors;

    // ghosts
    uint256 public stakedIn;
    uint256 public withdrawn;
    uint256[2] public notified; // [USDG, PLTH]
    uint256[2] public claimed;
    mapping(address => uint64) public firstStakeBucket; // 0 = never staked
    uint256 public stateCalls; // state-changing staking calls (each may floor away < 1 wei per term)

    bool public earlyWithdrawSucceeded;
    bool public claimMismatch; // claim() paid something other than what earned() showed
    bool public jitPaid; // a stake earned from a bucket it was not active through
    bool public dustOverflow; // rewards lost beyond floor rounding, or owed beyond funding
    uint256[2] public maxDust;

    uint256 public stakes;
    uint256 public unstakes;
    uint256 public withdraws;
    uint256 public claimsPaid;
    uint256 public notifies;

    constructor(PlinthStaking staking_, IERC20 plth_, MockERC20 usdg_) {
        staking = staking_;
        plth = plth_;
        usdg = usdg_;
        actors = [makeAddr("s0"), makeAddr("s1"), makeAddr("s2"), makeAddr("s3")];
    }

    function actorCount() external pure returns (uint256) {
        return 4;
    }

    function _bucket() internal view returns (uint64) {
        return uint64(block.timestamp / 1 hours);
    }

    // ------------------------------------------------------------ actions

    function stake(uint256 seed, uint256 amount) external {
        address a = actors[seed % 4];
        // spans every tier (0, 10k, 100k, 1M PLTH)
        amount = bound(amount, 1, 1_500_000e18);
        if (amount > plth.balanceOf(address(this))) return;
        plth.transfer(a, amount);
        vm.startPrank(a);
        plth.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
        stakedIn += amount;
        if (firstStakeBucket[a] == 0) firstStakeBucket[a] = _bucket();
        ++stakes;
        ++stateCalls;
    }

    function unstake(uint256 seed, uint256 amount) external {
        address a = actors[seed % 4];
        uint256 have = staking.stakedOf(a);
        if (have == 0) return;
        amount = bound(amount, 1, have);
        vm.prank(a);
        staking.unstake(amount);
        ++unstakes;
        ++stateCalls;
    }

    function withdraw(uint256 seed) external {
        address a = actors[seed % 4];
        (,, uint256 unbonding, uint64 releaseAt) = staking.stakerOf(a);
        if (unbonding == 0) return;
        if (block.timestamp < releaseAt) {
            vm.prank(a);
            try staking.withdraw() {
                earlyWithdrawSucceeded = true;
            } catch {}
            return;
        }
        uint256 before = plth.balanceOf(a);
        vm.prank(a);
        uint256 got = staking.withdraw();
        if (got != unbonding || plth.balanceOf(a) - before != unbonding) earlyWithdrawSucceeded = true;
        withdrawn += got;
        ++withdraws;
    }

    function claim(uint256 seed) external {
        address a = actors[seed % 4];
        uint256[2] memory e = staking.earned(a);
        vm.prank(a);
        (uint256 u, uint256 p) = staking.claim();
        if (u != e[0] || p != e[1]) claimMismatch = true;
        claimed[0] += u;
        claimed[1] += p;
        if (u != 0 || p != 0) ++claimsPaid;
        ++stateCalls;
    }

    function notifyUsdg(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        usdg.mint(address(this), amount);
        usdg.approve(address(staking), amount);
        staking.notifyReward(address(usdg), amount);
        notified[0] += amount;
        ++notifies;
        ++stateCalls;
    }

    function notifyPlth(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e18);
        if (amount > plth.balanceOf(address(this))) return;
        plth.approve(address(staking), amount);
        staking.notifyReward(address(plth), amount);
        notified[1] += amount;
        ++notifies;
        ++stateCalls;
    }

    /// Small steps stay inside an hour, larger ones cross buckets, the largest cross the unbonding.
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    /// After a roll `queued` is exact, so the unowned remainder (funded - claimed - claimable - queued) is pure
    /// floor-rounding dust. Each sync floors at most two terms per token, so it is bounded by the call count.
    function roll() external {
        staking.roll();
        ++stateCalls;
        for (uint256 k; k < 2; ++k) {
            uint256 owed = claimed[k] + staking.queued(k);
            for (uint256 i; i < 4; ++i) {
                owed += staking.earned(actors[i])[k];
            }
            if (owed > notified[k]) {
                dustOverflow = true; // owes more than it was given
                continue;
            }
            uint256 dust = notified[k] - owed;
            if (dust > maxDust[k]) maxDust[k] = dust;
            if (dust > 2 * stateCalls + 2) dustOverflow = true;
        }
    }

    // ------------------------------------------------------------ checks used by the invariants

    /// JIT: a stake first made in bucket h is pending through h and active from h+1, so the earliest rewards
    /// it can receive are those notified in h+1, distributed when h+1 ends. Until then it must show nothing.
    function checkJit() external {
        uint64 b = _bucket();
        for (uint256 i; i < 4; ++i) {
            uint64 f = firstStakeBucket[actors[i]];
            if (f == 0 || b > f + 1) continue;
            uint256[2] memory e = staking.earned(actors[i]);
            if (e[0] != 0 || e[1] != 0) jitPaid = true;
        }
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 500
/// forge-config: ci.invariant.fail-on-revert = true
contract PlinthStakingInvariantTest is TokenFixture {
    StakingHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new StakingHandler(staking, IERC20(address(plth)), usdg);
        vm.prank(worker);
        plth.transfer(address(handler), 400_000_000e18);

        bytes4[] memory sels = new bytes4[](9);
        sels[0] = StakingHandler.stake.selector;
        sels[1] = StakingHandler.unstake.selector;
        sels[2] = StakingHandler.withdraw.selector;
        sels[3] = StakingHandler.claim.selector;
        sels[4] = StakingHandler.notifyUsdg.selector;
        sels[5] = StakingHandler.notifyPlth.selector;
        sels[6] = StakingHandler.warp.selector;
        sels[7] = StakingHandler.roll.selector;
        sels[8] = StakingHandler.checkJit.selector;
        targetSelector(FuzzSelector(address(handler), sels));
        targetContract(address(handler));
    }

    function _sums() internal view returns (uint256 staked, uint256 unbonding, uint256[2] memory earned) {
        for (uint256 i; i < 4; ++i) {
            address a = handler.actors(i);
            staked += staking.stakedOf(a);
            (,, uint256 u,) = staking.stakerOf(a);
            unbonding += u;
            uint256[2] memory e = staking.earned(a);
            earned[0] += e[0];
            earned[1] += e[1];
        }
    }

    /// The supply counters equal the sum over stakers (staked = active + pending; unbonding apart).
    function invariant_totalsEqualSumOfStakers() public view {
        (uint256 staked, uint256 unbonding,) = _sums();
        assertEq(staking.activeSupply() + staking.pendingSupply(), staked, "staked total");
        assertEq(staking.unbondingSupply(), unbonding, "unbonding total");
    }

    /// PLTH in == PLTH out: the balance is exactly staked + unbonding + rewards notified - rewards claimed.
    function invariant_plthBalanceConserved() public view {
        uint256 principal = staking.activeSupply() + staking.pendingSupply() + staking.unbondingSupply();
        assertEq(principal, handler.stakedIn() - handler.withdrawn(), "principal");
        assertEq(
            plth.balanceOf(address(staking)), principal + handler.notified(1) - handler.claimed(1), "plth balance"
        );
        assertEq(usdg.balanceOf(address(staking)), handler.notified(0) - handler.claimed(0), "usdg balance");
    }

    /// The contract always covers what it owes: principal plus every staker's claimable reward, per token.
    function invariant_balancesCoverStakeAndClaimable() public view {
        (uint256 staked, uint256 unbonding, uint256[2] memory earned) = _sums();
        assertGe(plth.balanceOf(address(staking)), staked + unbonding + earned[1], "plth cover");
        assertGe(usdg.balanceOf(address(staking)), earned[0], "usdg cover");
    }

    /// Nobody is ever owed or paid more than was funded: claimed + claimable <= notified, per token.
    function invariant_noRewardsBeyondFunding() public view {
        (,, uint256[2] memory earned) = _sums();
        assertLe(handler.claimed(0) + earned[0], handler.notified(0), "usdg over-distributed");
        assertLe(handler.claimed(1) + earned[1], handler.notified(1), "plth over-distributed");
    }

    /// Each staker's tier is the highest whose minStake their staked amount (active + pending) reaches.
    function invariant_tierMatchesStake() public view {
        uint256 n = staking.tierCount();
        for (uint256 i; i < 4; ++i) {
            address a = handler.actors(i);
            uint256 amt = staking.stakedOf(a);
            uint256 t = staking.tierIndexOf(a);
            assertLe(staking.tierSpec(t).minStake, amt, "tier too high");
            if (t + 1 < n) assertGt(staking.tierSpec(t + 1).minStake, amt, "tier too low");
        }
    }

    /// Unbonding cannot be withdrawn early, and a withdrawal pays exactly the unbonding amount.
    function invariant_noEarlyWithdraw() public view {
        assertFalse(handler.earlyWithdrawSucceeded());
    }

    /// `claim` pays exactly what `earned` showed, and a just-in-time stake earns nothing.
    function invariant_claimMatchesEarnedAndNoJit() public view {
        assertFalse(handler.claimMismatch(), "claim != earned");
        assertFalse(handler.jitPaid(), "jit stake earned");
    }

    /// Funded rewards are never lost: what is neither claimed, claimable nor queued is rounding dust only.
    function invariant_rewardsLostOnlyToRounding() public view {
        assertFalse(handler.dustOverflow());
    }

    function afterInvariant() public view {
        console2.log("maxDust usdg", handler.maxDust(0), "plth", handler.maxDust(1));
        console2.log("stakes", handler.stakes(), "unstakes", handler.unstakes());
        console2.log("withdraws", handler.withdraws(), "claimsPaid", handler.claimsPaid());
        console2.log("notifies", handler.notifies());
    }

    /// The handler reaches every path the invariants depend on (stake, rewards, unbond, withdraw, claim).
    function test_handlerReachesEveryPath() public {
        handler.stake(0, 20_000e18);
        handler.stake(1, 200_000e18);
        handler.warp(1 hours);
        handler.notifyUsdg(1000e6);
        handler.notifyPlth(5000e18);
        handler.warp(1 hours);
        handler.claim(0);
        assertGt(handler.claimed(0), 0);
        assertGt(handler.claimed(1), 0);
        handler.unstake(1, 50_000e18);
        handler.withdraw(1); // early: must refuse
        assertFalse(handler.earlyWithdrawSucceeded());
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(1 days + 1);
        handler.withdraw(1);
        assertEq(handler.withdrawn(), 50_000e18);
        invariant_totalsEqualSumOfStakers();
        invariant_plthBalanceConserved();
        invariant_balancesCoverStakeAndClaimable();
        invariant_noRewardsBeyondFunding();
        invariant_tierMatchesStake();
    }
}
