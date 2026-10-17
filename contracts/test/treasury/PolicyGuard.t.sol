// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {MockEquitySleeve} from "../mocks/TreasuryMocks.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

contract PolicyGuardTest is TreasuryFixture {
    event GuardDecision(bytes32 indexed opHash, bytes32 indexed deskId, uint8 code);

    // ------------------------------------------------------------ baseline

    function test_fixture_startsInsideBands() public view {
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        assertEq(s.nav, 1_000_000e18);
        assertEq(s.cashUsd, 600_000e18);
        assertEq(s.equityUsd, 400_000e18);
        assertFalse(s.equityHold);
        assertEq(s.assets.length, 6);
    }

    function test_execute_buyPassesAndEmitsGuardDecision() public {
        bytes memory data = _buyData(address(nvda), 10_000e6);
        bytes32 opHash = account.opHashOf(EQUITY_DESK, address(eqSleeve), data);
        vm.expectEmit(address(account));
        emit GuardDecision(opHash, EQUITY_DESK, 0);
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
        assertGt(nvda.balanceOf(address(account)), 0);
        assertEq(usdg.allowance(address(account), address(eqSleeve)), 0, "approval reset");
        assertApproxEqRel(guard.dayTotal(address(account)), 9_985e18, 1e15);
    }

    function test_navUsd_matchesGuardSnapshot() public {
        _buy(address(nvda), 10_000e6);
        _deposit(50_000e6);
        (uint256 nav, bool hold) = account.navUsd();
        assertEq(nav, _nav());
        assertFalse(hold);
    }

    function test_navUsd_delistedHoldingCountsZeroAndHold() public {
        del.mint(address(account), 1e18);
        (uint256 nav, bool hold) = account.navUsd();
        assertEq(nav, 1_000_000e18);
        assertTrue(hold);
        assertTrue(guard.snapshot(address(account)).equityHold);
    }

    // ------------------------------------------------------------ rule 1: desk scope

    function test_rule1_strangerRejected() public {
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(1);
        vm.prank(stranger);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule1_adapterOutsideDeskRejected() public {
        bytes memory data = _data(address(usdg), 1_000e6, 0, address(0), 1_000e6);
        _expectCode(1);
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(cashSleeve), data, _allow(address(vault)), 0);
    }

    function test_rule1_otherDesksKeyRejected() public {
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(1);
        vm.prank(cashKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule1_revokedDeskRejected() public {
        vm.prank(board);
        account.revokeDesk(EQUITY_DESK);
        assertFalse(account.isDeskKey(eqKey));
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(1);
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    // ------------------------------------------------------------ rule 2: allowlist + canonical

    function test_rule2_assetNotInAllowRootRejected() public {
        bytes memory data = _buyData(address(bad), 1_000e6);
        _expectCode(guard.R2_NOT_ALLOWED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(bad)), 0);
    }

    function test_rule2_proofForAnotherAssetRejected() public {
        bytes memory data = _buyData(address(aapl), 1_000e6);
        _expectCode(guard.R2_NOT_ALLOWED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule2_cashIncreaseAlsoNeedsProof() public {
        bytes memory data = _sellData(address(aapl), 10e18);
        _expectCode(guard.R2_NOT_ALLOWED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, new bytes32[](0), 0);
    }

    function test_rule2_malformedProofLengthRejected() public {
        bytes memory data = _buyData(address(nvda), 1_000e6);
        bytes32[] memory p = _allow(address(nvda));
        p[0] = bytes32(uint256(99));
        _expectCode(guard.R2_NOT_ALLOWED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, p, 0);
    }

    function test_rule2_allowedButNotCanonicalRejected() public {
        // DEL is in the policy allowlist but delisted in the registry.
        bytes memory data = _data(address(usdg), 1_000e6, 6, address(del), 1_000e6);
        _expectCode(guard.R2_NOT_CANONICAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(del)), 0);
    }

    function test_rule2_packProofsLayout() public view {
        bytes32[][] memory ps = new bytes32[][](2);
        ps[0] = _merkleProof(2);
        ps[1] = _merkleProof(0);
        bytes32[] memory packed = guard.packProofs(ps);
        assertEq(packed.length, 8);
        assertEq(uint256(packed[0]), 3);
        assertEq(packed[1], ps[0][0]);
        assertEq(uint256(packed[4]), 3);
        assertEq(packed[7], ps[1][2]);
    }

    // ------------------------------------------------------------ rule 3: order + day caps

    function test_rule3_perOrderCapRejected() public {
        // notional = (101k out + ~100.7k in) / 2 > 100k cap
        bytes memory data = _buyData(address(nvda), 101_000e6);
        _expectCode(guard.R3_ORDER_CAP());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function _churn() internal {
        // 5 ops of ~$49.9k notional each: ~$249.6k of the $250k day cap.
        _buy(address(nvda), 50_000e6);
        _sell(address(aapl), 250e18);
        _buy(address(nvda), 50_000e6);
        _sell(address(aapl), 250e18);
        _buy(address(nvda), 50_000e6);
    }

    function test_rule3_dayCapRejected() public {
        _churn();
        assertLe(guard.dayTotal(address(account)), 250_000e18);
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R3_DAY_CAP());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule3_dayCapRollsAfterFullWindow() public {
        _churn();
        // 24h later the old hour is still inside the conservative 25-bucket window.
        _warp(T0 + 24 hours);
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R3_DAY_CAP());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
        // One more hour and the window has fully rolled.
        _warp(T0 + 25 hours);
        assertEq(guard.dayTotal(address(account)), 0);
        _buy(address(nvda), 1_000e6);
    }

    function test_rule3_dayTotalSumsAcrossHours() public {
        _buy(address(nvda), 10_000e6);
        _warp(T0 + 5 hours);
        _buy(address(nvda), 10_000e6);
        assertApproxEqRel(guard.dayTotal(address(account)), 2 * 9_985e18, 1e15);
        _warp(T0 + 25 hours);
        assertApproxEqRel(guard.dayTotal(address(account)), 9_985e18, 1e15);
    }

    // ------------------------------------------------------------ rule 4: bands

    function test_rule4_breachFromInsideBandRejected() public {
        aapl.mint(address(account), 2500e18); // equity $900k / NAV $1.5M = 60%, exactly at the max
        bytes memory data = _buyData(address(nvda), 10_000e6);
        _expectCode(guard.R4_BAND());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule4_outOfBandMovingTowardAllowed() public {
        aapl.mint(address(account), 3000e18); // equity 62.5%, cash 37.5%: both out of band
        _sell(address(aapl), 100e18);
    }

    function test_rule4_outOfBandMovingAwayRejected() public {
        aapl.mint(address(account), 3000e18);
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R4_BAND());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule4_allCashBuyingTowardBandAllowed() public {
        vm.prank(board);
        account.withdrawToBoard(address(aapl), SEED_AAPL); // cash 100%, equity 0%
        _buy(address(nvda), 10_000e6);
    }

    function test_rule4_crossingTheBandIsNotToward() public view {
        TreasuryPolicy.Band memory b = TreasuryPolicy.Band(3000, 6000);
        assertFalse(guard.bandOk(b, 0, 0.65e18), "below to above");
        assertFalse(guard.bandOk(b, 0.7e18, 0.25e18), "above to below");
        assertTrue(guard.bandOk(b, 0.7e18, 0.65e18), "above, closer");
        assertTrue(guard.bandOk(b, 0, 0.1e18), "below, closer");
        assertFalse(guard.bandOk(b, 0.1e18, 0.05e18), "below, further");
        assertFalse(guard.bandOk(b, 0.1e18, 0.1e18), "unchanged outside");
        assertTrue(guard.bandOk(b, 0.9e18, 0.6e18), "into band");
    }

    function testFuzz_rule4_bandOkMeansInsideOrCloserSameSide(uint16 lo, uint16 hi, uint64 wb, uint64 wa) public view {
        lo = uint16(bound(lo, 0, 10_000));
        hi = uint16(bound(hi, lo, 10_000));
        uint256 wBefore = bound(wb, 0, 1e18);
        uint256 wAfter = bound(wa, 0, 1e18);
        uint256 l = uint256(lo) * 1e14;
        uint256 h = uint256(hi) * 1e14;
        bool ok = guard.bandOk(TreasuryPolicy.Band(lo, hi), wBefore, wAfter);
        bool inside = wAfter >= l && wAfter <= h;
        bool closerBelow = wAfter < l && wBefore < wAfter;
        bool closerAbove = wAfter > h && wBefore > wAfter;
        assertEq(ok, inside || closerBelow || closerAbove);
    }

    // ------------------------------------------------------------ rules 5-6: unknown changes

    function test_rule6_valueLeakRejected() public {
        bytes memory data = _data(address(usdg), 1_000e6, 2, address(0), 1_000e6);
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, new bytes32[](0), 0);
    }

    function test_rule6_ethChangeRejected() public {
        vm.deal(address(eqSleeve), 1 ether);
        bytes memory data = _data(address(0), 0, 3, address(0), 1);
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, new bytes32[](0), 0);
    }

    function test_rule6_assetSetChangedMidOpRejected() public {
        MockStockToken x = new MockStockToken("X", "X");
        bytes memory data = _data(address(0), 0, 4, address(x), 0);
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, new bytes32[](0), 0);
    }

    function test_rule6_lossAboveMaxOpLossRejected() public {
        eqSleeve.setFee(300); // 3% fill cost > 2% allowed
        bytes memory data = _buyData(address(nvda), 10_000e6);
        _expectCode(guard.R6_UNKNOWN_CHANGE());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule6_normalFeesAllowed() public {
        eqSleeve.setFee(150);
        _buy(address(nvda), 10_000e6);
    }

    function test_rule6_noopAllowed() public {
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), _data(address(0), 0, 5, address(0), 0), new bytes32[](0), 0);
        assertEq(guard.dayTotal(address(account)), 0);
    }

    // ------------------------------------------------------------ rule 7: off-hours

    function _aaplOnHold() internal {
        aaplFeed.setUpdatedAt(block.timestamp - 2 hours);
    }

    function test_rule7_offHoursBuyRejected() public {
        _aaplOnHold();
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R7_OFF_HOURS());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule7_buyingAStaleTokenRejected() public {
        nvdaFeed.setUpdatedAt(block.timestamp - 2 hours); // not held yet, held after
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R7_OFF_HOURS());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule7_offHoursCashShuffleRejected() public {
        _aaplOnHold();
        bytes memory data = _data(address(usdg), 1_000e6, 0, address(0), 1_000e6);
        _expectCode(guard.R7_OFF_HOURS());
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), data, _allow(address(vault)), 0);
    }

    function test_rule7_offHoursSellAllowed() public {
        _aaplOnHold();
        _sell(address(aapl), 10e18);
    }

    function test_rule7_flagOffAllowsBuy() public {
        TreasuryPolicy.Policy memory p = _policy();
        p.noNewRiskOffHours = false;
        vm.prank(board);
        policy.propose(p);
        _warp(T0 + 48 hours);
        policy.activate();
        _aaplOnHold();
        _buy(address(nvda), 1_000e6);
    }

    // ------------------------------------------------------------ rule 8: drawdown

    function test_rule8_pausedRejectsBuy() public {
        periodClose.set(_nav() * 105 / 100); // -4.76%
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R8_PAUSED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule8_pausedAllowsSellAndCashShuffle() public {
        periodClose.set(_nav() * 105 / 100);
        _sell(address(aapl), 10e18);
        _deposit(10_000e6);
    }

    function test_rule8_deriskRejectsCashShuffle() public {
        periodClose.set(_nav() * 110 / 100); // -9.09%
        bytes memory data = _data(address(usdg), 1_000e6, 0, address(0), 1_000e6);
        _expectCode(guard.R8_DERISK());
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), data, _allow(address(vault)), 0);
    }

    function test_rule8_deriskRejectsBuy() public {
        periodClose.set(_nav() * 110 / 100);
        bytes memory data = _buyData(address(nvda), 1_000e6);
        _expectCode(guard.R8_DERISK());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule8_deriskAllowsSellTowardCash() public {
        periodClose.set(_nav() * 110 / 100);
        _sell(address(aapl), 10e18);
    }

    function test_rule8_smallDrawdownAllowsBuy() public {
        periodClose.set(_nav() * 103 / 100); // -2.9%
        _buy(address(nvda), 1_000e6);
    }

    function test_rule8_noPeriodCloseDisablesRule() public {
        TreasuryAccount d = new TreasuryAccount(board, policy, guard, address(approvals)); // never given a PeriodClose
        vm.startPrank(board);
        d.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        d.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        vm.stopPrank();
        usdg.mint(address(d), FUNDING);
        aapl.mint(address(d), SEED_AAPL);
        vm.prank(eqKey);
        d.execute(EQUITY_DESK, address(eqSleeve), _buyData(address(nvda), 1_000e6), _allow(address(nvda)), 0);
    }

    // ------------------------------------------------------------ rules 7 and 8: rounding dust (B2, fork run 2026-10-06)

    /// A cash -> cash deposit that loses `loss` USDG (a vault paying a few wei less than it was valued at).
    function _lossy(uint256 amount, uint256 loss) internal view returns (bytes memory data) {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(address(usdg), amount);
        data = abi.encode(pulls, abi.encode(uint8(2), address(uint160(loss)), amount));
    }

    /// The equity weight change (WAD) the operation would cause, measured by running the adapter as the account
    /// on a throwaway copy of the state.
    function _eqWeightUp(uint256 amount, uint256 loss) internal returns (int256) {
        PolicyGuard.Snapshot memory b = guard.snapshot(address(account));
        uint256 id = vm.snapshotState();
        vm.startPrank(address(account));
        usdg.approve(address(cashSleeve), amount);
        cashSleeve.run(abi.encode(uint8(2), address(uint160(loss)), amount));
        vm.stopPrank();
        PolicyGuard.Snapshot memory a = guard.snapshot(address(account));
        vm.revertToState(id);
        return int256(a.equityUsd * 1e18 / a.nav) - int256(b.equityUsd * 1e18 / b.nav);
    }

    /// Lead (audit): a desk could sandwich its own swaps, losing up to maxOpLossBps (200 bps) of every operation's
    /// notional to a colluding pool. With a day cap that is large next to NAV that adds up; the rolling 24 h op
    /// loss is now bounded in bps of NAV as well.
    function test_poc_selfSandwichBoundedPerDay() public {
        TreasuryPolicy.Policy memory p = _policy();
        p.perOrderCapUsd = 500_000;
        p.perDayCapUsd = 5_000_000;
        p.approvalAboveUsd = 1_000_000;
        vm.prank(board);
        policy.propose(p);
        _warp(block.timestamp + 48 hours);
        policy.activate();
        // Three 100k cash -> cash moves, each losing 1.9% (inside 200 bps of its notional): $5.7k in all.
        for (uint256 i; i < 2; ++i) {
            vm.prank(cashKey);
            account.execute(CASH_DESK, address(cashSleeve), _lossy(100_000e6, 1_900e6), _allow(address(vault)), 0);
        }
        _expectCode(19); // R6_DAY_LOSS: over 50 bps of NAV lost to operations in 24 h
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), _lossy(100_000e6, 1_900e6), _allow(address(vault)), 0);
    }

    function test_weightDustIs1e12() public view {
        assertEq(guard.WEIGHT_DUST(), 1e12);
    }

    /// PAUSED: a neutral cash -> cash move whose rounding nudges the equity weight up by dust passes.
    function test_rule8_pausedAllowsCashMoveWithRoundingDust() public {
        periodClose.set(_nav() * 105 / 100);
        int256 up = _eqWeightUp(10_000e6, 1);
        assertGt(up, 0, "the rounding does raise the equity weight");
        assertLe(up, 1e12);
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), _lossy(10_000e6, 1), _allow(address(vault)), 0);
    }

    /// PAUSED, fuzzed across the boundary: up to WEIGHT_DUST passes, anything above is R8_PAUSED.
    function testFuzz_rule8_pausedDustBoundary(uint256 loss) public {
        // NAV $1M at 40% equity: the 1e12 boundary is a loss of ~$2.50; fuzz $0 .. $10.
        loss = bound(loss, 0, 10e6);
        periodClose.set(_nav() * 105 / 100);
        int256 up = _eqWeightUp(10_000e6, loss);
        if (up > int256(guard.WEIGHT_DUST())) _expectCode(guard.R8_PAUSED());
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), _lossy(10_000e6, loss), _allow(address(vault)), 0);
    }

    function test_rule8_pausedRejectsEquityWeightJustAboveDust() public {
        periodClose.set(_nav() * 105 / 100);
        uint256 loss = 2_600_000; // $2.60 on $1M at 40% equity: just above 1e12
        int256 up = _eqWeightUp(10_000e6, loss);
        assertGt(up, 1e12);
        assertLt(up, 1.1e12);
        _expectCode(guard.R8_PAUSED());
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), _lossy(10_000e6, loss), _allow(address(vault)), 0);
    }

    /// The tolerance never lets a Stock Token in: a buy too small to move the weight by dust is still R8_PAUSED.
    function test_rule8_pausedRejectsDustSizedBuy() public {
        periodClose.set(_nav() * 105 / 100);
        bytes memory data = _buyData(address(nvda), 1e5); // $0.10
        _expectCode(guard.R8_PAUSED());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    /// Off-hours keeps its spec (only operations that reduce the equity weight): a cash move is refused whichever
    /// way its rounding falls, because a change within WEIGHT_DUST is no change.
    function testFuzz_rule7_offHoursCashMoveRefusedWhateverTheDust(uint256 loss) public {
        loss = bound(loss, 0, 2e6);
        _aaplOnHold();
        _expectCode(guard.R7_OFF_HOURS());
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cashSleeve), _lossy(10_000e6, loss), _allow(address(vault)), 0);
    }

    // ------------------------------------------------------------ rule 9: approvals

    function _bigBuy() internal view returns (bytes memory data, bytes32 opHash) {
        data = _buyData(address(nvda), 60_000e6);
        opHash = account.opHashOf(EQUITY_DESK, address(eqSleeve), data);
    }

    function _ticket(bytes32 opHash) internal returns (bytes32 t) {
        vm.prank(eqKey);
        t = approvals.request(opHash);
        vm.prank(board);
        approvals.approve(t);
    }

    function test_rule9_aboveThresholdWithoutTicketRejected() public {
        (bytes memory data,) = _bigBuy();
        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), 0);
    }

    function test_rule9_approvedTicketPassesOnceThenConsumed() public {
        (bytes memory data, bytes32 opHash) = _bigBuy();
        bytes32 t = _ticket(opHash);
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
        assertEq(uint8(approvals.ticketOf(t).status), uint8(BoardApprovals.Status.Consumed));

        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
    }

    function test_rule9_requestedButNotApprovedRejected() public {
        (bytes memory data, bytes32 opHash) = _bigBuy();
        vm.prank(eqKey);
        bytes32 t = approvals.request(opHash);
        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
    }

    function test_rule9_rejectedTicketRejected() public {
        (bytes memory data, bytes32 opHash) = _bigBuy();
        bytes32 t = _ticket(opHash);
        vm.prank(board);
        approvals.reject(t);
        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
    }

    function test_rule9_ticketOlderThan24hRejected() public {
        (bytes memory data, bytes32 opHash) = _bigBuy();
        bytes32 t = _ticket(opHash);
        _warp(T0 + 24 hours + 1);
        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
    }

    function test_rule9_ticketForAnotherOpRejected() public {
        (bytes memory data,) = _bigBuy();
        bytes32 t = _ticket(keccak256("another op"));
        _expectCode(guard.R9_APPROVAL());
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), data, _allow(address(nvda)), t);
    }

    function test_rule9_belowThresholdNeedsNoTicket() public {
        _buy(address(nvda), 50_000e6); // notional ~49.9k <= 50k
    }

    // ------------------------------------------------------------ guard access

    function test_check_onlyCallableByTheAccountItself() public {
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        vm.expectRevert(PolicyGuard.NotAccount.selector);
        guard.check(address(account), bytes32(0), s, new bytes32[](0), 0);
    }

    function test_constructor_rejectsLossAbove10pct() public {
        vm.expectRevert(PolicyGuard.BadLossBps.selector);
        new PolicyGuard(registry, valuer, 1001);
    }

    // ------------------------------------------------------------ gas

    function test_gas_check() public {
        PolicyGuard.Snapshot memory s = guard.snapshot(address(account));
        vm.prank(address(account));
        uint256 g = gasleft();
        uint8 code = guard.check(address(account), bytes32(0), s, new bytes32[](0), 0);
        uint256 used = g - gasleft();
        assertEq(code, 0);
        console2.log("PolicyGuard.check gas (6 assets, no-op):", used);

        bytes memory data = _buyData(address(nvda), 10_000e6);
        bytes32[] memory proof = _allow(address(nvda));
        vm.prank(eqKey);
        g = gasleft();
        account.execute(EQUITY_DESK, address(eqSleeve), data, proof, 0);
        console2.log("TreasuryAccount.execute gas (buy, snapshot+run+check):", g - gasleft());
    }
}
