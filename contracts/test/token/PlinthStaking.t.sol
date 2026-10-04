// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenFixture} from "./TokenFixture.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {Tier} from "../../src/token/ITierSource.sol";

contract PlinthStakingTest is TokenFixture {
    // ------------------------------------------------------------ tiers

    function test_tierBoundaries() public {
        uint256[4] memory mins = [uint256(0), T1_MIN, T2_MIN, T3_MIN];
        uint8[4] memory desks = [uint8(2), 4, 8, 16];
        assertEq(staking.tierIndexOf(alice), 0);
        for (uint256 i = 1; i < 4; ++i) {
            uint256 have = staking.stakedOf(alice);
            _stake(alice, mins[i] - 1 - have);
            assertEq(staking.tierIndexOf(alice), i - 1, "one below the boundary");
            _stake(alice, 1);
            assertEq(staking.tierIndexOf(alice), i, "at the boundary");
            Tier memory t = staking.tierOf(alice);
            assertEq(t.maxDesks, desks[i]);
            assertEq(t.templatePriority, i);
        }
        Tier memory top = staking.tierOf(alice);
        assertTrue(top.weeklyClose && top.privateSleeve);
        Tier memory none = staking.tierOf(bob);
        assertEq(none.maxDesks, 2);
        assertFalse(none.weeklyClose || none.privateSleeve);
    }

    function test_tierFlagsPerTier() public {
        _stake(alice, T1_MIN);
        Tier memory t = staking.tierOf(alice);
        assertTrue(t.weeklyClose);
        assertFalse(t.privateSleeve);
        _stake(alice, T2_MIN - T1_MIN);
        assertTrue(staking.tierOf(alice).privateSleeve);
    }

    function test_unbondingStakeDoesNotCountForTier() public {
        _stake(alice, T1_MIN);
        assertEq(staking.tierIndexOf(alice), 1);
        vm.prank(alice);
        staking.unstake(1);
        assertEq(staking.tierIndexOf(alice), 0);
    }

    function test_badTiersRevert() public {
        PlinthStaking.TierSpec[] memory t = _tiers();
        t[0].minStake = 1;
        vm.expectRevert(PlinthStaking.BadTiers.selector);
        new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), t);
        t = _tiers();
        t[2].minStake = t[1].minStake;
        vm.expectRevert(PlinthStaking.BadTiers.selector);
        new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), t);
        vm.expectRevert(PlinthStaking.BadTiers.selector);
        new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), new PlinthStaking.TierSpec[](0));
    }

    // ------------------------------------------------------------ hour buckets

    function test_newStakeIsPendingUntilNextHour() public {
        _stake(alice, 100e18);
        (uint256 a, uint256 p,,) = staking.stakerOf(alice);
        assertEq(a, 0);
        assertEq(p, 100e18);
        _nextHour();
        (a, p,,) = staking.stakerOf(alice);
        assertEq(a, 100e18);
        assertEq(p, 0);
    }

    function test_rewardsPaidWhenBucketEnds() public {
        _stake(alice, 100e18);
        _nextHour();
        _notify(address(usdg), 1000e6);
        assertEq(staking.earned(alice)[0], 0, "not before the hour ends");
        _nextHour();
        assertEq(staking.earned(alice)[0], 1000e6);
        vm.prank(alice);
        (uint256 u,) = staking.claim();
        assertEq(u, 1000e6);
        assertEq(usdg.balanceOf(alice), 1000e6);
    }

    function test_jitStakeEarnsNothing() public {
        _stake(alice, 100e18);
        _nextHour();
        // Same block: bob stakes a lot, then a large reward lands.
        _stake(bob, 1_000_000e18);
        _notify(address(usdg), 1000e6);
        _notify(address(plth), 50e18);
        _nextHour();
        assertEq(staking.earned(bob)[0], 0);
        assertEq(staking.earned(bob)[1], 0);
        assertEq(staking.earned(alice)[0], 1000e6);
        assertEq(staking.earned(alice)[1], 50e18);
    }

    function test_stakeInLastSecondOfHourEarnsNothingFromThatHour() public {
        _stake(alice, 100e18);
        _nextHour();
        vm.warp(block.timestamp + 1 hours - 1);
        _stake(bob, 100e18);
        _notify(address(usdg), 1000e6);
        _nextHour();
        assertEq(staking.earned(bob)[0], 0);
        // From the next hour bob is active and shares.
        _notify(address(usdg), 1000e6);
        _nextHour();
        assertEq(staking.earned(bob)[0], 500e6);
        assertEq(staking.earned(alice)[0], 1500e6);
    }

    function test_unstakeMidBucketForfeitsThatBucket() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        _nextHour();
        _notify(address(usdg), 1000e6);
        vm.prank(bob);
        staking.unstake(100e18);
        _nextHour();
        assertEq(staking.earned(bob)[0], 0);
        assertEq(staking.earned(alice)[0], 1000e6);
    }

    function test_rewardsQueuedWhileNobodyActive() public {
        _notify(address(usdg), 1000e6);
        _nextHour();
        staking.roll();
        assertEq(staking.queued(0), 1000e6, "carried");
        _stake(alice, 1e18);
        _nextHour();
        _nextHour();
        assertEq(staking.earned(alice)[0], 1000e6);
    }

    function test_notifyRejectsOtherTokens() public {
        vm.expectRevert(abi.encodeWithSelector(PlinthStaking.NotRewardToken.selector, address(0xBEEF)));
        staking.notifyReward(address(0xBEEF), 1);
    }

    // ------------------------------------------------------------ unbonding

    function test_unbondingTakesSevenDays() public {
        _stake(alice, 100e18);
        _nextHour();
        vm.prank(alice);
        staking.unstake(40e18);
        (uint256 a,, uint256 u, uint64 rel) = staking.stakerOf(alice);
        assertEq(a, 60e18);
        assertEq(u, 40e18);
        assertEq(rel, block.timestamp + 7 days);
        vm.warp(rel - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlinthStaking.StillUnbonding.selector, rel));
        staking.withdraw();
        vm.warp(rel);
        vm.prank(alice);
        staking.withdraw();
        assertEq(plth.balanceOf(alice), 40e18);
    }

    function test_newUnstakeRestartsUnbonding() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        staking.unstake(10e18);
        vm.warp(block.timestamp + 6 days);
        vm.prank(alice);
        staking.unstake(10e18);
        (,, uint256 u, uint64 rel) = staking.stakerOf(alice);
        assertEq(u, 20e18);
        assertEq(rel, block.timestamp + 7 days);
    }

    function test_unstakeMoreThanStakedReverts() public {
        _stake(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlinthStaking.InsufficientStake.selector, 1e18, 2e18));
        staking.unstake(2e18);
    }

    function test_plthRewardsDoNotTouchStake() public {
        _stake(alice, 100e18);
        _nextHour();
        _notify(address(plth), 7e18);
        _nextHour();
        vm.startPrank(alice);
        staking.claim();
        staking.unstake(100e18);
        vm.warp(block.timestamp + 7 days);
        staking.withdraw();
        vm.stopPrank();
        assertEq(plth.balanceOf(alice), 107e18);
        assertEq(plth.balanceOf(address(staking)), 0);
    }

    // ------------------------------------------------------------ fuzz

    /// Pro rata between whole-hour stakers, nothing for a stake made in the reward's hour, never more
    /// than notified.
    function testFuzz_rewardsProRataNoJit(uint96 a, uint96 b, uint96 jit, uint64 reward, uint16 offset) public {
        a = uint96(bound(a, 1e15, 1e26));
        b = uint96(bound(b, 1e15, 1e26));
        jit = uint96(bound(jit, 1, 1e26));
        reward = uint64(bound(reward, 1, 1e15));
        _stake(alice, a);
        _stake(bob, b);
        _nextHour();
        vm.warp(block.timestamp + bound(offset, 0, 3599));
        _stake(carol, jit);
        _notify(address(usdg), reward);
        _nextHour();
        uint256 ea = staking.earned(alice)[0];
        uint256 eb = staking.earned(bob)[0];
        assertEq(staking.earned(carol)[0], 0, "jit");
        assertLe(ea + eb, reward);
        uint256 total = uint256(a) + b;
        assertApproxEqAbs(ea, uint256(reward) * a / total, 2);
        assertApproxEqAbs(eb, uint256(reward) * b / total, 2);
        // carry: the remainder is still queued
        staking.roll();
        assertLe(ea + eb + staking.queued(0), reward);
        assertGe(ea + eb + staking.queued(0) + 2, reward); // at most rounding dust is unassigned
    }

    /// Random stakes, unstakes, rewards and claims over many hours: everyone can always claim and withdraw,
    /// and at the end the contract holds only undistributed remainders.
    function testFuzz_solventAcrossBuckets(uint256 seed) public {
        address[3] memory who = [alice, bob, carol];
        uint256 notifiedU;
        uint256 notifiedP;
        for (uint256 i; i < 24; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address w = who[r % 3];
            uint256 amt = (r >> 8) % 1e24 + 1;
            uint256 op = (r >> 128) % 5;
            if (op == 0) {
                _stake(w, amt);
            } else if (op == 1) {
                uint256 st = staking.stakedOf(w);
                if (st != 0) {
                    vm.prank(w);
                    staking.unstake(amt % st + 1);
                }
            } else if (op == 2) {
                uint256 u = amt % 1e12 + 1;
                _notify(address(usdg), u);
                notifiedU += u;
            } else if (op == 3) {
                _notify(address(plth), amt);
                notifiedP += amt;
            } else {
                vm.prank(w);
                staking.claim();
            }
            vm.warp(block.timestamp + (r >> 200) % 2 hours);
        }
        _nextHour();
        _nextHour();
        uint256 paidU;
        for (uint256 j; j < 3; ++j) {
            vm.startPrank(who[j]);
            staking.claim();
            uint256 st = staking.stakedOf(who[j]);
            if (st != 0) staking.unstake(st);
            vm.warp(block.timestamp + 7 days);
            (,, uint256 ub,) = staking.stakerOf(who[j]);
            if (ub != 0) staking.withdraw();
            vm.stopPrank();
            paidU += usdg.balanceOf(who[j]);
        }
        assertLe(paidU, notifiedU);
        assertEq(usdg.balanceOf(address(staking)), notifiedU - paidU);
        assertEq(staking.activeSupply() + staking.pendingSupply() + staking.unbondingSupply(), 0);
        // what is left in PLTH is only reward remainder
        assertLe(plth.balanceOf(address(staking)), notifiedP);
    }
}
