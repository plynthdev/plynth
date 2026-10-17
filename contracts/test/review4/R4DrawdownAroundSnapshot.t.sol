// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {R3DrawdownStartNavTest} from "../review3/R3DrawdownStartNav.t.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";

/// review4 R4-TREAS-3 regression. withdrawToBoard(540k) just before the controller's snapshot, returned right
/// after, stored periodStartNav = $460k for a $1M book, so a real -20% loss read as +74% and the drawdown rule was
/// off for the period. Withdrawals since the previous close are now added back to the drawdown base, so no
/// withdrawal can lower it. Real PeriodClose and PolicyGuard.
contract R4DrawdownAroundSnapshotTest is R3DrawdownStartNavTest {
    function test_r4_withdrawAroundSnapshotCannotSwitchDrawdownRuleOff() public {
        _warp(block.timestamp + 1);
        vm.prank(board);
        account.withdrawToBoard(address(usdg), 540_000e6);
        vm.prank(controller);
        (bytes32 posHash, uint256 nav, uint16 cashBps, uint16 eqBps) = pc.snapshot();
        vm.prank(board);
        usdg.transfer(address(account), 540_000e6);
        (, bytes32 h, uint32 v) = policy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(block.timestamp), nav, cashBps, eqBps, posHash, keccak256("bundle"), h, v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(controllerKey, pc.digest(c));
        pc.commitSnapshot(c, abi.encodePacked(r, s, vv));
        (uint256 live,) = account.navUsd();
        assertEq(c.navUsd + 540_000e18, live, "the statement was the drained book");
        assertEq(pc.periodStartNav(), live, "the base adds the withdrawal back: the real $1M");

        _crash(); // real -20%
        _buyRefused();
    }
}
