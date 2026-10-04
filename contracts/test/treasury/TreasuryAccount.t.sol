// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TreasuryFixture} from "./TreasuryFixture.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {MockEquitySleeve, ForceEth} from "./mocks/TreasuryMocks.sol";

contract TreasuryAccountTest is TreasuryFixture {
    // ------------------------------------------------------------ desks

    function test_registerDesk_onlyBoard() public {
        vm.expectRevert(TreasuryAccount.NotBoard.selector);
        account.registerDesk("x", stranger, _one(address(eqSleeve)));
    }

    function test_registerDesk_validates() public {
        vm.startPrank(board);
        vm.expectRevert(TreasuryAccount.BadDesk.selector);
        account.registerDesk(bytes32(0), stranger, _one(address(eqSleeve)));
        vm.expectRevert(TreasuryAccount.BadDesk.selector);
        account.registerDesk("x", address(0), _one(address(eqSleeve)));
        vm.expectRevert(TreasuryAccount.DeskActive.selector);
        account.registerDesk(EQUITY_DESK, stranger, _one(address(eqSleeve)));
        vm.expectRevert(TreasuryAccount.BadAdapters.selector);
        account.registerDesk("x", stranger, new address[](0));
        address[] memory two = new address[](2);
        two[0] = address(eqSleeve);
        two[1] = address(eqSleeve);
        vm.expectRevert(TreasuryAccount.BadAdapters.selector);
        account.registerDesk("x", stranger, two);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.BadSleeve.selector, stranger));
        account.registerDesk("x", stranger, _one(stranger));
        vm.stopPrank();
    }

    function test_registerDesk_rejectsSleeveSharingAnAsset() public {
        address[] memory toks = new address[](1);
        toks[0] = address(aapl);
        MockEquitySleeve other = new MockEquitySleeve(valuer, usdg, toks);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.DuplicateAsset.selector, address(aapl)));
        account.registerDesk("x", stranger, _one(address(other)));
    }

    function test_revokeDesk_keepsSleeveHoldingsInNav() public {
        uint256 navBefore = _nav();
        vm.startPrank(board);
        account.revokeDesk(EQUITY_DESK);
        account.revokeDesk(CASH_DESK);
        vm.expectRevert(TreasuryAccount.DeskNotActive.selector);
        account.revokeDesk(CASH_DESK);
        vm.stopPrank();
        assertEq(_nav(), navBefore);
        (uint256 nav,) = account.navUsd();
        assertEq(nav, navBefore);
        assertEq(account.sleeves().length, 2);
    }

    function test_reregisterAfterRevoke() public {
        vm.startPrank(board);
        account.revokeDesk(EQUITY_DESK);
        account.registerDesk(EQUITY_DESK, stranger, _one(address(eqSleeve)));
        vm.stopPrank();
        assertTrue(account.isDeskKey(stranger));
        assertFalse(account.isDeskKey(eqKey));
        assertEq(account.desk(EQUITY_DESK).key, stranger);
    }

    function test_setPeriodClose_onlyBoard() public {
        vm.expectRevert(TreasuryAccount.NotBoard.selector);
        account.setPeriodClose(stranger);
    }

    function test_opHash_bindsEveryInput() public view {
        bytes memory d = _buyData(address(nvda), 1e6);
        bytes32 h = account.opHashOf(EQUITY_DESK, address(eqSleeve), d);
        assertTrue(h != account.opHashOf(CASH_DESK, address(eqSleeve), d));
        assertTrue(h != account.opHashOf(EQUITY_DESK, address(cashSleeve), d));
        assertTrue(h != account.opHashOf(EQUITY_DESK, address(eqSleeve), _buyData(address(nvda), 2e6)));
    }

    // ------------------------------------------------------------ withdrawToBoard: never gated

    function test_withdrawToBoard_onlyBoard() public {
        vm.expectRevert(TreasuryAccount.NotBoard.selector);
        account.withdrawToBoard(address(usdg), 1);
    }

    function test_withdrawToBoard_worksWhenPausedDeriskOnHoldAndAllDesksRevoked() public {
        // DERISK (and therefore past PAUSED): period-start NAV far above the current NAV.
        periodClose.set(_nav() * 2);
        // Every feed on hold.
        aaplFeed.setUpdatedAt(block.timestamp - 3 days);
        nvdaFeed.setUpdatedAt(block.timestamp - 3 days);
        // Every desk revoked.
        vm.startPrank(board);
        account.revokeDesk(EQUITY_DESK);
        account.revokeDesk(CASH_DESK);

        account.withdrawToBoard(address(usdg), FUNDING);
        account.withdrawToBoard(address(aapl), SEED_AAPL);
        vm.stopPrank();
        assertEq(usdg.balanceOf(board), FUNDING);
        assertEq(aapl.balanceOf(board), SEED_AAPL);
        assertEq(_nav(), 0);
    }

    function test_withdrawToBoard_worksInPaused() public {
        periodClose.set(_nav() * 105 / 100);
        vm.prank(board);
        account.withdrawToBoard(address(aapl), 1e18);
        assertEq(aapl.balanceOf(board), 1e18);
    }

    function test_withdrawToBoard_eth() public {
        new ForceEth{value: 1 ether}(payable(address(account)));
        vm.prank(board);
        account.withdrawToBoard(address(0), 1 ether);
        assertEq(board.balance, 1 ether);
    }

    function test_withdrawToBoard_delistedToken() public {
        del.mint(address(account), 5e18);
        vm.prank(board);
        account.withdrawToBoard(address(del), 5e18);
        assertEq(del.balanceOf(board), 5e18);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(TreasuryAccount.ZeroAddress.selector);
        new TreasuryAccount(address(0), policy, guard, address(approvals));
    }
}

contract BoardApprovalsTest is TreasuryFixture {
    bytes32 constant OP = keccak256("op");

    function test_bindAccount_onceAndOnlyBoard() public {
        vm.expectRevert(BoardApprovals.NotBoard.selector);
        approvals.bindAccount(stranger);
        vm.prank(board);
        vm.expectRevert(BoardApprovals.AlreadyBound.selector);
        approvals.bindAccount(stranger);
    }

    function test_request_onlyActiveDeskKey() public {
        vm.prank(stranger);
        vm.expectRevert(BoardApprovals.NotDesk.selector);
        approvals.request(OP);

        vm.prank(eqKey);
        bytes32 t = approvals.request(OP);
        assertEq(t, bytes32(uint256(1)));
        BoardApprovals.Ticket memory k = approvals.ticketOf(t);
        assertEq(k.opHash, OP);
        assertEq(k.requester, eqKey);
        assertEq(uint8(k.status), uint8(BoardApprovals.Status.Requested));

        vm.prank(board);
        account.revokeDesk(EQUITY_DESK);
        vm.prank(eqKey);
        vm.expectRevert(BoardApprovals.NotDesk.selector);
        approvals.request(OP);
    }

    function test_request_needsBoundAccount() public {
        BoardApprovals fresh = new BoardApprovals(board, address(guard));
        vm.prank(eqKey);
        vm.expectRevert(BoardApprovals.NotBound.selector);
        fresh.request(OP);
    }

    function test_approveReject_onlyBoardAndStatusRules() public {
        vm.prank(eqKey);
        bytes32 t = approvals.request(OP);
        vm.expectRevert(BoardApprovals.NotBoard.selector);
        approvals.approve(t);
        vm.expectRevert(BoardApprovals.NotBoard.selector);
        approvals.reject(t);

        vm.startPrank(board);
        approvals.approve(t);
        assertTrue(approvals.isValid(t, OP, address(account)));
        vm.expectRevert(abi.encodeWithSelector(BoardApprovals.BadStatus.selector, BoardApprovals.Status.Approved));
        approvals.approve(t);
        approvals.reject(t);
        assertFalse(approvals.isValid(t, OP, address(account)));
        vm.expectRevert(abi.encodeWithSelector(BoardApprovals.BadStatus.selector, BoardApprovals.Status.Rejected));
        approvals.reject(t);
        vm.expectRevert(abi.encodeWithSelector(BoardApprovals.BadStatus.selector, BoardApprovals.Status.None));
        approvals.approve(bytes32(uint256(99)));
        vm.stopPrank();
    }

    function test_approve_afterTtlRejected() public {
        vm.prank(eqKey);
        bytes32 t = approvals.request(OP);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(board);
        vm.expectRevert(BoardApprovals.Expired.selector);
        approvals.approve(t);
    }

    function test_isValid_expiresAfter24hFromRequest() public {
        vm.prank(eqKey);
        bytes32 t = approvals.request(OP);
        vm.warp(block.timestamp + 23 hours);
        vm.prank(board);
        approvals.approve(t);
        vm.warp(block.timestamp + 1 hours);
        assertTrue(approvals.isValid(t, OP, address(account)));
        vm.warp(block.timestamp + 1);
        assertFalse(approvals.isValid(t, OP, address(account)));
    }

    function test_consume_onlyGuardOnceRightAccountAndOp() public {
        vm.prank(eqKey);
        bytes32 t = approvals.request(OP);
        vm.prank(board);
        approvals.approve(t);

        vm.expectRevert(BoardApprovals.NotGuard.selector);
        approvals.consume(t, OP, address(account));

        vm.startPrank(address(guard));
        vm.expectRevert(BoardApprovals.WrongAccount.selector);
        approvals.consume(t, OP, stranger);
        vm.expectRevert(BoardApprovals.InvalidTicket.selector);
        approvals.consume(t, keccak256("other"), address(account));
        approvals.consume(t, OP, address(account));
        vm.expectRevert(BoardApprovals.InvalidTicket.selector);
        approvals.consume(t, OP, address(account));
        vm.stopPrank();
        assertEq(uint8(approvals.ticketOf(t).status), uint8(BoardApprovals.Status.Consumed));
    }
}
