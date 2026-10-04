// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFixture} from "../treasury/TreasuryFixture.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";

contract ExceptionInsurancePoolTest is TreasuryFixture {
    ExceptionInsurancePool pool;
    address committee = makeAddr("committee");
    address lp = makeAddr("lp");
    address lp2 = makeAddr("lp2");
    bytes32 constant EVIDENCE = keccak256("evidence");

    function setUp() public override {
        super.setUp();
        pool = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee);
    }

    function _fund(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(pool), amount);
        pool.depositFees(amount);
    }

    function _lp(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        shares = pool.deposit(amount);
        vm.stopPrank();
    }

    function _file(uint256 lossUsd) internal returns (uint256 id) {
        vm.prank(board);
        id = pool.fileClaim(account, lossUsd, EVIDENCE);
    }

    function _approveBoth(uint256 id) internal {
        vm.prank(committee);
        pool.approveClaim(id);
        vm.prank(controller);
        pool.attest(id, true);
    }

    // ------------------------------------------------------------ filing

    function test_onlyBoardFiles() public {
        vm.prank(stranger);
        vm.expectRevert(ExceptionInsurancePool.NotBoard.selector);
        pool.fileClaim(account, 1e18, EVIDENCE);
        uint256 id = _file(1000e18);
        ExceptionInsurancePool.Claim memory c = pool.claim(id);
        assertEq(c.amount, 1000e6, "1e18 USD -> 6dp USDG");
        assertEq(c.treasury, address(account));
        assertEq(c.board, board);
        assertEq(c.evidenceHash, EVIDENCE);
        assertEq(uint8(c.status), uint8(ExceptionInsurancePool.Status.Filed));
    }

    // ------------------------------------------------------------ both approvals

    function test_committeeAloneDoesNotPay() public {
        _fund(10_000e6);
        uint256 id = _file(1000e18);
        vm.prank(committee);
        pool.approveClaim(id);
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Filed));
        assertEq(usdg.balanceOf(address(account)), FUNDING);
    }

    function test_controllerAloneDoesNotPay() public {
        _fund(10_000e6);
        uint256 id = _file(1000e18);
        vm.prank(controller);
        pool.attest(id, true);
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Filed));
        assertEq(usdg.balanceOf(address(account)), FUNDING);
    }

    function test_bothApprovalsPayTheTreasury() public {
        _fund(10_000e6);
        uint256 id = _file(1000e18);
        vm.prank(controller);
        pool.attest(id, true);
        vm.prank(committee);
        pool.approveClaim(id); // order does not matter
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Paid));
        assertEq(usdg.balanceOf(address(account)), FUNDING + 1000e6);
        assertEq(usdg.balanceOf(board), 0, "paid to the account, not the board");
    }

    function test_marketMoveAttestationRejects() public {
        _fund(10_000e6);
        uint256 id = _file(1000e18);
        vm.prank(committee);
        pool.approveClaim(id);
        vm.prank(controller);
        pool.attest(id, false);
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Rejected));
        assertEq(usdg.balanceOf(address(pool)), 10_000e6);
    }

    function test_onlyCommitteeAndController() public {
        uint256 id = _file(1e18);
        vm.prank(stranger);
        vm.expectRevert(ExceptionInsurancePool.NotCommittee.selector);
        pool.approveClaim(id);
        vm.prank(stranger);
        vm.expectRevert(ExceptionInsurancePool.NotCommittee.selector);
        pool.rejectClaim(id);
        vm.prank(board);
        vm.expectRevert(ExceptionInsurancePool.NotController.selector);
        pool.attest(id, true);
        vm.prank(committee);
        pool.rejectClaim(id);
        vm.prank(controller);
        vm.expectRevert(
            abi.encodeWithSelector(ExceptionInsurancePool.BadStatus.selector, ExceptionInsurancePool.Status.Rejected)
        );
        pool.attest(id, true);
    }

    function test_doubleApprovalReverts() public {
        uint256 id = _file(1e18);
        vm.startPrank(committee);
        pool.approveClaim(id);
        vm.expectRevert(ExceptionInsurancePool.AlreadyDone.selector);
        pool.approveClaim(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ payout cap + FIFO

    function test_payoutCappedAtBalanceThenCompleted() public {
        _fund(300e6);
        uint256 id = _file(1000e18);
        _approveBoth(id);
        ExceptionInsurancePool.Claim memory c = pool.claim(id);
        assertEq(c.paid, 300e6);
        assertEq(uint8(c.status), uint8(ExceptionInsurancePool.Status.Queued));
        assertEq(usdg.balanceOf(address(pool)), 0);
        assertEq(pool.queuedOwed(), 700e6);
        _fund(1000e6); // fees arriving pay the head first
        c = pool.claim(id);
        assertEq(c.paid, 1000e6);
        assertEq(uint8(c.status), uint8(ExceptionInsurancePool.Status.Paid));
        assertEq(usdg.balanceOf(address(pool)), 300e6);
        assertEq(usdg.balanceOf(address(account)), FUNDING + 1000e6);
    }

    function test_claimsPaidFifo() public {
        uint256 a = _file(500e18);
        uint256 b = _file(200e18);
        _approveBoth(a);
        _approveBoth(b);
        assertEq(pool.queueLength(), 2);
        assertEq(pool.queueAt(0), a);
        _fund(600e6);
        assertEq(pool.claim(a).paid, 500e6, "head first, in full");
        assertEq(pool.claim(b).paid, 100e6, "then the next, capped");
        _fund(100e6);
        assertEq(uint8(pool.claim(b).status), uint8(ExceptionInsurancePool.Status.Paid));
        assertEq(pool.queueLength(), 0);
    }

    function testFuzz_payoutNeverExceedsBalance(uint64 bal, uint64 loss) public {
        bal = uint64(bound(bal, 0, 1e15));
        loss = uint64(bound(loss, 1, 1e15));
        if (bal != 0) _fund(bal);
        uint256 id = _file(uint256(loss) * 1e12);
        _approveBoth(id);
        uint256 paid = pool.claim(id).paid;
        assertEq(paid, bal < loss ? bal : loss);
        assertEq(usdg.balanceOf(address(pool)), uint256(bal) - paid);
        assertEq(pool.queuedOwed(), uint256(loss) - paid);
    }

    // ------------------------------------------------------------ LPs

    function test_lpWithdrawalDelay() public {
        uint256 s = _lp(lp, 1000e6);
        vm.prank(lp);
        pool.requestWithdraw(s);
        uint64 ready = uint64(block.timestamp + 14 days);
        vm.warp(ready - 1);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.NotReady.selector, ready));
        pool.withdraw();
        vm.warp(ready);
        vm.prank(lp);
        uint256 out = pool.withdraw();
        assertApproxEqAbs(out, 1000e6, 1);
    }

    function test_withdrawingSharesStillBearClaims() public {
        uint256 s = _lp(lp, 1000e6);
        _lp(lp2, 1000e6);
        vm.prank(lp);
        pool.requestWithdraw(s);
        uint256 id = _file(1000e18);
        _approveBoth(id); // pays 1000 of 2000
        vm.warp(block.timestamp + 14 days);
        vm.prank(lp);
        uint256 out = pool.withdraw();
        assertApproxEqAbs(out, 500e6, 1, "lost half like everyone else");
    }

    function test_feesRaiseShareValue() public {
        _lp(lp, 1000e6);
        _fund(100e6);
        uint256 s = pool.sharesOf(lp);
        assertApproxEqAbs(pool.previewRedeem(s), 1100e6, 1);
    }

    function test_queuedOwedNotCountedForLps() public {
        _lp(lp, 100e6);
        uint256 id = _file(300e18);
        _approveBoth(id); // pays 100, owes 200
        assertEq(pool.freeAssets(), 0);
        _fund(250e6); // 200 to the claim, 50 free
        assertEq(pool.freeAssets(), 50e6);
    }

    /// First-depositor inflation: donating fees before a victim deposits cannot steal the deposit.
    function test_inflationAttackUnprofitable() public {
        _lp(lp, 1); // attacker: 1 raw unit
        _fund(10_000e6); // attacker "donates" via fees
        uint256 victimShares = _lp(lp2, 10_000e6);
        assertGt(victimShares, 0);
        assertApproxEqRel(pool.previewRedeem(victimShares), 10_000e6, 0.001e18);
    }
}
