// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFixture} from "../treasury/TreasuryFixture.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PLTH} from "../../src/token/PLTH.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {ITierSource, Tier} from "../../src/interfaces/ITierSource.sol";

/// PeriodClose reads the board's staking tier: a period under 28 days (weekly close) needs `weeklyClose`.
contract TierWiringTest is TreasuryFixture {
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)
    address worker = makeAddr("worker");
    PLTH plth;
    PlinthStaking staking;

    function setUp() public override {
        super.setUp();
        plth = new PLTH(worker, makeAddr("plthTreasury"), makeAddr("reserve"));
        PlinthStaking.TierSpec[] memory t = new PlinthStaking.TierSpec[](2);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        t[1] = PlinthStaking.TierSpec(10_000e18, Tier(4, true, false, 1));
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), t, 7 days);
    }

    function _weeklyPolicy() internal {
        TreasuryPolicy.Policy memory p = _policy();
        p.periodSeconds = 7 days;
        vm.prank(board);
        policy.propose(p);
        _warp(block.timestamp + policy.TIMELOCK());
        policy.activate();
    }

    function _wireMockPeriodClose() internal pure override returns (bool) {
        return false;
    }

    function _newClose(ITierSource tiers) internal returns (PeriodClose pc) {
        pc = new PeriodClose(account, IERC20Metadata(address(usdg)), makeAddr("feeRouter"), tiers);
        vm.prank(board);
        account.setPeriodClose(address(pc));
    }

    function _commitAfter(PeriodClose pc, uint256 dt) internal {
        _warp(block.timestamp + dt);
        (, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = pc.preview();
        (, bytes32 h, uint32 v) = policy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(block.timestamp), nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(controllerKey, pc.digest(c));
        pc.commit(c, abi.encodePacked(r, s, sv));
    }

    function _boardStakes(uint256 amount) internal {
        vm.prank(worker);
        plth.transfer(board, amount);
        vm.startPrank(board);
        plth.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function test_weeklyCloseNeedsTier() public {
        _weeklyPolicy();
        PeriodClose pc = _newClose(staking);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.TierTooLow.selector, board));
        this.commitAfter(pc, 7 days);
        _boardStakes(10_000e18);
        _commitAfter(pc, 0);
        assertEq(pc.closeCount(), 1);
    }

    function test_monthlyCloseNeedsNoTier() public {
        PeriodClose pc = _newClose(staking);
        _commitAfter(pc, 30 days);
        assertEq(pc.closeCount(), 1);
    }

    function test_noTierSourceMeansNoGate() public {
        _weeklyPolicy();
        PeriodClose pc = _newClose(ITierSource(address(0)));
        _commitAfter(pc, 7 days);
        assertEq(pc.closeCount(), 1);
    }

    function test_tierLostAfterUnstakeBlocksNextWeeklyClose() public {
        _weeklyPolicy();
        PeriodClose pc = _newClose(staking);
        _boardStakes(10_000e18);
        _commitAfter(pc, 7 days);
        vm.prank(board);
        staking.unstake(1);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.TierTooLow.selector, board));
        this.commitAfter(pc, 7 days);
    }

    function commitAfter(PeriodClose pc, uint256 dt) external {
        _commitAfter(pc, dt);
    }
}
