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
        pool = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, 14 days);
        pool.bindFeeRouter(address(this)); // this test plays the FeeRouter
    }

    /// Router fees (this contract is the bound FeeRouter).
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
        _lp(lp2, 10_000e6); // LP capital backs the claims
        uint256 id = _file(1000e18);
        vm.prank(committee);
        pool.approveClaim(id);
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Filed));
        assertEq(usdg.balanceOf(address(account)), FUNDING);
    }

    function test_controllerAloneDoesNotPay() public {
        _lp(lp2, 10_000e6); // LP capital backs the claims
        uint256 id = _file(1000e18);
        vm.prank(controller);
        pool.attest(id, true);
        assertEq(uint8(pool.claim(id).status), uint8(ExceptionInsurancePool.Status.Filed));
        assertEq(usdg.balanceOf(address(account)), FUNDING);
    }

    function test_bothApprovalsPayTheTreasury() public {
        _lp(lp2, 10_000e6); // LP capital backs the claims
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
        _lp(lp2, 10_000e6); // LP capital backs the claims
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
        _lp(lp, 300e6);
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
        if (bal != 0) _lp(lp, bal);
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

    // ------------------------------------------------------------ security review 2026-10-06

    /// S2: a queued claim drained the pool (freeAssets 0). A 1 USDG deposit would mint ~all the shares and
    /// take every later fee; deposits must wait until the claims are paid.
    function test_S2_depositWhileClaimsDrainThePoolRefused() public {
        _lp(lp, 1_000e6);
        uint256 id = _file(3_000e18);
        _approveBoth(id); // pays 1,000, owes 2,000, balance 0
        assertEq(pool.freeAssets(), 0);

        address attacker = makeAddr("attacker");
        usdg.mint(attacker, 1e6);
        vm.startPrank(attacker);
        usdg.approve(address(pool), 1e6);
        vm.expectRevert(ExceptionInsurancePool.ClaimsOwed.selector);
        pool.deposit(1e6);
        vm.stopPrank();

        _fund(10_000e6); // 2,000 to the claim, 8,000 free: all of it belongs to the existing LP
        assertApproxEqAbs(pool.previewRedeem(pool.sharesOf(lp)), 8_000e6, 10);
        uint256 s = _lp(lp2, 8_000e6); // once the queue is clear, deposits are fair again
        assertApproxEqAbs(pool.previewRedeem(s), 8_000e6, 10);
    }

    /// S2: every share lost its value to a paid claim; a newcomer must not buy all future fees for 1 unit.
    function test_S2_depositIntoZeroValueSharesRefused() public {
        _lp(lp, 1_000e6);
        uint256 id = _file(1_000e18);
        _approveBoth(id); // pays exactly the balance
        assertEq(pool.queueLength(), 0);
        assertEq(pool.freeAssets(), 0);
        usdg.mint(lp2, 1e6);
        vm.startPrank(lp2);
        usdg.approve(address(pool), 1e6);
        vm.expectRevert(ExceptionInsurancePool.SharesUnderwater.selector);
        pool.deposit(1e6);
        vm.stopPrank();
    }

    /// S12: shares waiting to withdraw stop earning: an LP cannot stay "armed" for free and still collect
    /// every fee (they still bear claims).
    function test_S12_withdrawingSharesStopEarning() public {
        uint256 s = _lp(lp, 1_000e6);
        vm.prank(lp);
        pool.requestWithdraw(s); // armed right away
        _lp(lp2, 1_000e6);
        _fund(1_000e6); // fees arrive while lp waits
        vm.warp(block.timestamp + 14 days);
        vm.prank(lp);
        uint256 out = pool.withdraw();
        assertApproxEqAbs(out, 1_000e6, 1, "no fees for shares waiting to leave");
        assertApproxEqAbs(pool.previewRedeem(pool.sharesOf(lp2)), 2_000e6, 2, "the staying LP keeps them");
    }

    // ------------------------------------------------------------ delta review 2026-10-07 (D2, D3)

    function _requestAll(address who) internal returns (uint256 value) {
        uint256 s = pool.sharesOf(who);
        value = pool.previewRedeem(s);
        vm.prank(who);
        pool.requestWithdraw(s);
    }

    function _withdrawAfterDelay(address who) internal returns (uint256 out) {
        vm.warp(block.timestamp + 14 days);
        vm.prank(who);
        out = pool.withdraw();
    }

    /// D2: the only LP waits to withdraw while fees arrive. Nobody is insuring, so the fees go back to the
    /// router; nothing stays behind under the virtual shares to dilute the next LP's fees forever.
    function test_D2_lastLpLeavingLeavesNothingUnderVirtualShares() public {
        _lp(lp, 10_000e6);
        _requestAll(lp);
        assertEq(pool.activeShares(), 0);
        uint256 routerBefore = usdg.balanceOf(address(this));
        _fund(10_000e6); // fees while lp waits
        assertEq(usdg.balanceOf(address(this)) - routerBefore, 10_000e6, "fees nobody insures go back to the router");
        assertApproxEqAbs(_withdrawAfterDelay(lp), 10_000e6, 1);
        assertEq(usdg.balanceOf(address(pool)), 0, "nothing left ownerless");

        uint256 s2 = _lp(lp2, 10_000e6);
        assertApproxEqAbs(pool.previewRedeem(s2), 10_000e6, 1);
        _fund(10_000e6);
        assertApproxEqAbs(pool.previewRedeem(s2), 20_000e6, 2, "the new LP gets every fee it insures");
    }

    /// D2: a donation (or rounding dust) while no active share exists is handed back, not left to the
    /// virtual shares; anyone can trigger it.
    function test_D2_idleSurplusReturnedToRouter() public {
        _lp(lp, 1_000e6);
        _requestAll(lp);
        usdg.mint(address(pool), 777e6); // a direct transfer
        uint256 before = usdg.balanceOf(address(this));
        vm.prank(stranger);
        pool.returnIdle();
        assertEq(usdg.balanceOf(address(this)) - before, 777e6);
        assertApproxEqAbs(pool.pendingValueOf(lp), 1_000e6, 1, "the withdrawer's liability is untouched");
    }

    /// D3: a newcomer depositing just before a withdrawer exits buys at the active price, so it captures none
    /// of the fees the staying LP earned (old pricing let it take ~4,926 of lp2's 5,000).
    function test_D3_depositBeforeExitCannotCaptureStayersFees() public {
        _lp(lp, 10_000e6);
        uint256 s2 = _lp(lp2, 10_000e6);
        _requestAll(lp);
        _fund(10_000e6); // all of it is lp2's: lp stopped earning at the request
        assertApproxEqAbs(pool.previewRedeem(s2), 20_000e6, 2);

        address attacker = makeAddr("attacker");
        vm.warp(block.timestamp + 14 days - 1);
        uint256 sa = _lp(attacker, 1_000_000e6);
        vm.warp(block.timestamp + 1);
        vm.prank(lp);
        assertApproxEqAbs(pool.withdraw(), 10_000e6, 1);

        assertApproxEqAbs(pool.previewRedeem(s2), 20_000e6, 2, "the staying LP keeps its fees");
        assertLe(pool.previewRedeem(sa), 1_000_000e6, "the newcomer gains nothing from the exit");
    }

    /// Withdrawing LPs still bear a claim exactly like active ones, and get min(value at request, value at
    /// withdraw): fees after the request never reach them.
    function test_D3_withdrawerBearsLossesButNoFees() public {
        _lp(lp, 1_000e6);
        uint256 s2 = _lp(lp2, 1_000e6);
        uint256 v = _requestAll(lp);
        _approveBoth(_file(500e18)); // 25% of 2,000
        assertApproxEqAbs(pool.pendingValueOf(lp), 750e6, 1);
        assertApproxEqAbs(pool.previewRedeem(s2), 750e6, 1);
        _fund(1_000e6); // fees: only lp2
        assertApproxEqAbs(pool.previewRedeem(s2), 1_750e6, 2);
        (uint256 requested, uint256 now_,) = pool.pendingOf(lp);
        assertEq(requested, v);
        assertApproxEqAbs(now_, 750e6, 1);
        assertApproxEqAbs(_withdrawAfterDelay(lp), 750e6, 1);
    }

    /// A claim that takes the whole pool wipes the pending withdrawals too; a later request starts afresh and
    /// is not diluted by the worthless old ones.
    function test_D3_wipedWithdrawalsDoNotDiluteLaterOnes() public {
        _lp(lp, 1_000e6);
        _requestAll(lp);
        _approveBoth(_file(1_000e18)); // takes everything
        assertEq(pool.pendingValueOf(lp), 0);
        uint256 s2 = _lp(lp2, 2_000e6); // no active share was left, so entry is at par
        assertApproxEqAbs(pool.previewRedeem(s2), 2_000e6, 1);
        vm.prank(lp2);
        pool.requestWithdraw(s2);
        assertApproxEqAbs(pool.pendingValueOf(lp2), 2_000e6, 1);
        assertEq(_withdrawAfterDelay(lp), 0, "wiped");
        vm.prank(lp2);
        assertApproxEqAbs(pool.withdraw(), 2_000e6, 1);
    }

    /// Fees arriving with no active LP pay an owed claim first; only the rest goes back to the router.
    function test_feesWithoutLpsPayClaimsThenReturn() public {
        _lp(lp, 100e6);
        _requestAll(lp);
        _approveBoth(_file(300e18)); // pays 100 (the withdrawer's liability is wiped), owes 200
        assertEq(pool.queuedOwed(), 200e6);
        uint256 before = usdg.balanceOf(address(this));
        _fund(500e6);
        assertEq(pool.queuedOwed(), 0);
        assertEq(usdg.balanceOf(address(account)), FUNDING + 300e6);
        assertEq(usdg.balanceOf(address(this)) - before, 300e6, "the 300 above the debt back to the router");
        assertEq(usdg.balanceOf(address(pool)), 0);
    }

    // ------------------------------------------------------------ delta review 2026-10-07 (D1)

    function _tryDeposit(address who, uint256 amount) internal returns (bool ok) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        try pool.deposit(amount) returns (uint256) {
            ok = true;
        } catch {}
        vm.stopPrank();
    }

    /// D1: a claim drained the pool (balance 0, queue clear). A 1-wei depositFees by anyone used to make
    /// freeAssets 1 and reopen deposits at ~0 price: 1,000 USDG then bought 99.99% of the shares and the next
    /// 5,000 of router fees. Now depositFees is router-only and a donation cannot lift the price to the floor.
    function test_D1_oneWeiDonationCannotReopenDeposits() public {
        _lp(lp, 10_000e6);
        uint256 id = _file((10_000e6 + 1) * 1e12);
        _approveBoth(id); // pays 10,000, owes 1 raw
        _fund(1); // router fee pays the last unit
        assertEq(pool.queuedOwed(), 0);
        assertEq(usdg.balanceOf(address(pool)), 0);

        address attacker = makeAddr("attacker");
        usdg.mint(attacker, 1);
        vm.startPrank(attacker);
        usdg.approve(address(pool), 1);
        vm.expectRevert(ExceptionInsurancePool.NotFeeRouter.selector);
        pool.depositFees(1);
        usdg.transfer(address(pool), 1); // a plain donation instead
        vm.stopPrank();
        assertFalse(_tryDeposit(attacker, 1_000e6), "deposit at a ~0 share price");
        assertEq(pool.sharesOf(attacker), 0);

        _fund(5_000e6); // the next router push restores the LPs who carried the claim
        assertApproxEqAbs(pool.previewRedeem(pool.sharesOf(lp)), 5_000e6, 2);
        assertTrue(_tryDeposit(attacker, 1_000e6), "reopened once the price is back at the floor");
        assertApproxEqAbs(pool.previewRedeem(pool.sharesOf(attacker)), 1_000e6, 1, "at a fair price");
        assertApproxEqAbs(pool.previewRedeem(pool.sharesOf(lp)), 5_000e6, 2, "the old LP keeps its value");
    }

    /// D1: a paid claim that leaves a few wei is no different from one that leaves nothing.
    function test_D1_claimDustCannotReopenDeposits() public {
        _lp(lp, 10_000e6);
        _approveBoth(_file((10_000e6 - 5) * 1e12)); // leaves 5 raw units
        assertEq(pool.freeAssets(), 5);
        address attacker = makeAddr("attacker");
        usdg.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        usdg.approve(address(pool), 1_000e6);
        vm.expectRevert(ExceptionInsurancePool.SharesUnderwater.selector);
        pool.deposit(1_000e6);
        vm.stopPrank();
    }

    /// The floor: deposits are open iff the active share price is at least MIN_PRICE_BPS of the entry price.
    function testFuzz_D1_depositFloor(uint256 lossBps) public {
        lossBps = bound(lossBps, 0, 9_999);
        _lp(lp, 10_000e6);
        if (lossBps != 0) _approveBoth(_file(10_000e6 * lossBps / 10_000 * 1e12));
        bool open = _tryDeposit(lp2, 1_000e6);
        uint256 left = 10_000e6 - 10_000e6 * lossBps / 10_000;
        if (left * 2 >= 10_000e6) assertTrue(open, "at or above half the entry price");
        else if (left * 2 + 2 < 10_000e6) assertFalse(open, "under half the entry price");
    }

    function test_depositFeesRouterOnlyAndBoundOnce() public {
        usdg.mint(stranger, 1e6);
        vm.startPrank(stranger);
        usdg.approve(address(pool), 1e6);
        vm.expectRevert(ExceptionInsurancePool.NotFeeRouter.selector);
        pool.depositFees(1e6);
        vm.expectRevert(ExceptionInsurancePool.NotDeployer.selector);
        pool.bindFeeRouter(stranger);
        vm.stopPrank();
        vm.expectRevert(ExceptionInsurancePool.AlreadyDone.selector);
        pool.bindFeeRouter(stranger);

        ExceptionInsurancePool fresh = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, 14 days);
        vm.expectRevert(ExceptionInsurancePool.ZeroAddress.selector);
        fresh.bindFeeRouter(address(0));
        vm.expectRevert(ExceptionInsurancePool.NotFeeRouter.selector);
        fresh.depositFees(1); // unbound: nobody
    }

    /// Shares a claim made worthless can still leave (nothing is paid); otherwise they could never exit and
    /// whatever lands under them later (a donation, dust) could never go back to the router.
    function test_worthlessSharesCanLeave() public {
        _lp(lp, 1_000e6);
        _approveBoth(_file(1_000e18));
        uint256 s = pool.sharesOf(lp);
        assertEq(pool.previewRedeem(s), 0);
        vm.prank(lp);
        pool.requestWithdraw(s);
        assertEq(pool.activeShares(), 0);
        assertEq(pool.pendingValueOf(lp), 0);
        vm.prank(lp);
        vm.expectRevert(ExceptionInsurancePool.ZeroAmount.selector);
        pool.withdraw(); // nothing pending
        usdg.mint(address(pool), 3);
        uint256 before = usdg.balanceOf(address(this));
        pool.returnIdle();
        assertEq(usdg.balanceOf(address(this)) - before, 3);
    }
}
