// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFixture} from "../treasury/TreasuryFixture.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {ITierSource} from "../../src/interfaces/ITierSource.sol";

/// review3 R3-TREAS-3 regression. `commitSnapshot` stored periodStartNav from the LIVE book after checking the
/// snapshot, so one board batch (withdrawToBoard 540k -> commitSnapshot -> transfer back) stored $460k for a $1M
/// book and a real -20% loss read as +74%: the drawdown rule was off for the period, with no timelock. The start
/// NAV is now the checked statement less the fee. Real PeriodClose and PolicyGuard.
contract R3DrawdownStartNavTest is TreasuryFixture {
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)
    PeriodClose pc;

    function _wireMockPeriodClose() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        pc = new PeriodClose(account, IERC20Metadata(address(usdg)), address(0), ITierSource(address(0)));
        vm.prank(board);
        account.setPeriodClose(address(pc));
    }

    function _close(bool aroundCommit) internal {
        _warp(block.timestamp + 1);
        vm.prank(controller);
        (bytes32 posHash, uint256 nav, uint16 cashBps, uint16 eqBps) = pc.snapshot();
        (, bytes32 h, uint32 v) = policy.current();
        PeriodClose.Close memory c =
            PeriodClose.Close(uint64(block.timestamp), nav, cashBps, eqBps, posHash, keccak256("bundle"), h, v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(controllerKey, pc.digest(c));
        if (!aroundCommit) {
            pc.commitSnapshot(c, abi.encodePacked(r, s, vv));
            return;
        }
        vm.startPrank(board); // the board's one batch (a Safe MultiSend)
        account.withdrawToBoard(address(usdg), 540_000e6);
        pc.commitSnapshot(c, abi.encodePacked(r, s, vv));
        usdg.transfer(address(account), 540_000e6);
        vm.stopPrank();
    }

    function _crash() internal {
        aaplFeed.set(100e8); // AAPL $200 -> $100: real NAV $1M -> $800k (-20%, past the -8% derisk line)
        _warp(block.timestamp + 1);
    }

    function _buyRefused() internal {
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R8_DERISK());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_r3_control_drawdownDerisksAfterHonestCommit() public {
        _close(false);
        _crash();
        _buyRefused();
    }

    function test_r3_withdrawAroundCommitCannotSwitchDrawdownRuleOff() public {
        _close(true);
        assertEq(pc.periodStartNav(), pc.latest().navUsd, "start = the signed statement, not the drained live book");
        _crash();
        _buyRefused();
    }
}
