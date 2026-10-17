// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PerpFixture} from "./PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Tests that close gaps found by mutation testing (contracts/mutation/REPORT.md).
contract PerpMarketMutationTest is PerpFixture {
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function setUp() public override {
        super.setUp();
        address[2] memory more = [carol, dave];
        for (uint256 i; i < more.length; i++) {
            vm.prank(more[i]);
            usdg.approve(address(pool), type(uint256).max);
        }
    }

    function _longs() internal view returns (uint256 size, uint256 tokens, uint256 collateral) {
        (size, tokens, collateral) = market.longs();
    }

    // ------------------------------------------------------------ defaults and admin

    function test_defaultParamsBeforeSetParams() public {
        PerpMarket m = new PerpMarket(pool, valuer, address(token), owner);
        assertEq(m.takerFeeBps(), 10);
        assertEq(m.makerFeeBps(), 2);
        assertEq(m.offHoursSpreadBps(), 1_000);
        assertEq(m.borrowBpsPerHour(), 1);
        assertEq(m.fundingK(), 2.78e11);
        assertEq(m.oiCapBps(), 2_000);
        assertEq(m.maxProfitBps(), 10_000);
        assertEq(m.liquidationFee(), 5e6);
    }

    function test_setParamsResyncsTheReserveOfAListedMarket() public {
        _open(alice, true, 10_000e6, 1_000e6);
        assertEq(pool.reserveOf(address(market)), market.reserve());
        _params(0, 0, 1000, 0, 0, 2_000, 5_000, 5e6); // halve maxProfit: the reserve halves
        assertEq(market.reserve(), 5_000e6);
        assertEq(pool.reserveOf(address(market)), 5_000e6);
    }

    // ------------------------------------------------------------ views

    function test_viewsForAnAccountWithoutPosition() public view {
        assertEq(market.equityOf(alice), 0);
        assertEq(market.exitValueOf(alice), 0);
        assertFalse(market.isLiquidatable(alice));
        (uint256 p, bool hold) = market.price();
        assertEq(p, 100e18);
        assertFalse(hold);
    }

    function test_traderPnlSumsBothSides() public {
        _open(alice, true, 10_000e6, 1_000e6);
        _open(bob, false, 5_000e6, 1_000e6);
        _setPrice(110e8);
        // long +1,000, short -500
        assertApproxEqAbs(market.traderPnl(), 500e6, 1);
    }

    function test_traderPnlAppliesTheProfitCap() public {
        _params(0, 0, 1000, 0, 0, 2_000, 5_000, 5e6);
        _open(alice, true, 1_000e6, 1_000e6);
        _setPrice(300e8); // +2,000 uncapped, cap 50% of size
        assertEq(market.traderPnl(), 500e6);
    }

    function test_staleWithOpenInterestWhenSidesAreEqual() public {
        _open(alice, true, 1_000e6, 100e6);
        _open(bob, false, 1_000e6, 100e6);
        assertFalse(market.staleWithOpenInterest());
        _hold();
        assertTrue(market.staleWithOpenInterest());
    }

    // ------------------------------------------------------------ entry guards

    function test_entryGuards() public {
        vm.startPrank(alice);
        vm.expectRevert(PerpMarket.NoPosition.selector);
        market.increase(1e6, 1e6, 10_000);
        vm.expectRevert(PerpMarket.NoPosition.selector);
        market.decrease(1e6);
        vm.expectRevert(PerpMarket.ZeroSize.selector);
        market.open(true, 0, 1e6, 10_000);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(PerpMarket.NoPosition.selector);
        market.liquidate(alice);

        _open(alice, true, 1_000e6, 100e6);
        _fund(alice, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(PerpMarket.HasPosition.selector);
        market.open(false, 1_000e6, 100e6, 10_000);
        vm.expectRevert(PerpMarket.ZeroSize.selector);
        market.decrease(0);
        vm.stopPrank();
    }

    function test_collateralBelowFeeAndEqualToFee() public {
        _params(100, 0, 1000, 0, 0, 2_000, 10_000, 5e6); // 1% taker fee
        _fund(alice, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.open(true, 1_000e6, 10e6 - 1, 10_000);
        vm.expectRevert(PerpMarket.Leverage.selector); // all of it goes to the fee: zero margin
        market.open(true, 1_000e6, 10e6, 10_000);
        vm.stopPrank();
    }

    function test_decreaseLargerThanSizeClosesFully() public {
        _open(alice, true, 1_000e6, 100e6);
        vm.prank(alice);
        market.decrease(5_000e6);
        assertEq(usdg.balanceOf(alice), 100e6);
        assertEq(market.position(alice).size, 0);
    }

    function test_fullCloseDeletesThePosition() public {
        _open(alice, true, 1_000e6, 100e6);
        _close(alice);
        PerpMarket.Position memory p = market.position(alice);
        assertFalse(p.isLong);
        assertEq(p.collateral, 0);
        assertEq(p.tokens, 0);
        (uint256 s, uint256 t, uint256 c) = _longs();
        assertEq(s, 0);
        assertEq(t, 0, "side tokens removed");
        assertEq(c, 0);
    }

    // ------------------------------------------------------------ margin changes

    function test_addingMarginNeedsNoSlippageAllowanceAndIgnoresOiCap() public {
        _params(10, 0, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, true, 100_000e6, 10_000e6);
        _params(10, 0, 1000, 0, 0, 500, 10_000, 5e6); // OI cap now 50k, side is 100k
        _fund(alice, 1_000e6);
        vm.prank(alice);
        market.increase(0, 1_000e6, 0); // risk-reducing: no fee, no slippage bound, no OI check
        assertEq(market.position(alice).collateral, 10_000e6 - 100e6 + 1_000e6);
    }

    function test_increaseRefusedWhenItLeavesThePositionBelowMaintenance() public {
        _open(alice, true, 10_000e6, 500e6); // 20x
        _setPrice(9_550_000_000); // equity 500 - 450 = 50, maintenance 100: liquidatable
        _fund(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Liquidatable.selector);
        market.increase(100e6, 1e6, 10_000); // leverage is fine (10,100 <= 501 x 50), equity is not
    }

    // ------------------------------------------------------------ token rounding

    function test_tokensRoundAgainstTheTraderOnOpenAndPartialDecrease() public {
        _setPrice(3e8);
        (uint256 pr,) = market.price();
        uint256 one = market.ONE();
        _open(alice, true, 10e6, 10e6);
        _open(bob, false, 10e6, 10e6);
        uint256 lt = Math.mulDiv(10e6, one, pr, Math.Rounding.Floor);
        uint256 st = Math.mulDiv(10e6, one, pr, Math.Rounding.Ceil);
        assertTrue(st == lt + 1, "inexact on purpose");
        assertEq(market.position(alice).tokens, lt);
        assertEq(market.position(bob).tokens, st);

        vm.prank(alice);
        market.decrease(3e6);
        vm.prank(bob);
        market.decrease(3e6);
        assertEq(market.position(alice).tokens, lt - Math.mulDiv(lt, 3e6, 10e6, Math.Rounding.Floor));
        assertEq(market.position(bob).tokens, st - Math.mulDiv(st, 3e6, 10e6, Math.Rounding.Ceil));
    }

    // ------------------------------------------------------------ partial decrease that takes from margin

    /// On hold a long exits at the oracle minus the spread: the released quarter's loss exceeds its collateral
    /// and the shortfall comes out of the remaining margin.
    function test_partialDecreaseShortfallTakenFromMargin() public {
        _open(alice, true, 10_000e6, 500e6);
        _hold(); // exec = 90 (10% spread)
        vm.prank(alice);
        market.decrease(2_500e6); // released 125, pnl -250: shortfall 125
        assertEq(usdg.balanceOf(alice), 0, "no payout");
        PerpMarket.Position memory p = market.position(alice);
        assertEq(p.size, 7_500e6);
        assertEq(p.collateral, 250e6);
        (,, uint256 sideColl) = _longs();
        assertEq(sideColl, 250e6);
    }

    function test_partialDecreaseRefusedWhenTheRestFallsBelowMaintenance() public {
        _open(alice, true, 10_000e6, 500e6);
        _setPrice(98e8);
        _hold(); // exec 88.2; after the quarter: margin 205, equity 205 - 150 = 55 < 75 maintenance
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Liquidatable.selector);
        market.decrease(2_500e6);
    }

    /// A shortfall larger than the remaining margin is refused with Liquidatable (not an arithmetic panic).
    function test_partialDecreaseShortfallAboveMarginRefused() public {
        _open(alice, true, 10_000e6, 200e6); // 50x
        _hold(); // released half: 100 collateral, -500 PnL at 90: shortfall 400 > 100 left
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Liquidatable.selector);
        market.decrease(5_000e6);
    }

    /// A shortfall can push the rest above 50x while equity is still above maintenance: Leverage catches it.
    function test_partialDecreaseRefusedWhenTheRestExceedsMaxLeverage() public {
        _open(alice, true, 10_000e6, 500e6); // 20x
        _hold(); // released 40%: 200 collateral, -400 PnL at 90: margin 300 - 200 = 100 for 6,000 (60x)
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Leverage.selector);
        market.decrease(4_000e6);
    }

    /// Equity exactly at maintenance is not liquidatable: margin can be added and half can be closed.
    function test_equityExactlyAtMaintenanceStillTrades() public {
        _open(alice, true, 1_000e6, 100e6);
        _setPrice(91e8); // equity 10 = maintenance
        assertEq(market.equityOf(alice), 10e6);
        vm.prank(alice);
        market.increase(0, 0, 10_000);
        vm.prank(alice);
        market.decrease(500e6); // the rest: equity 5 = maintenance of 500
        assertEq(market.equityOf(alice), 5e6);
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidateHealthyPositionReverts() public {
        _open(alice, true, 1_000e6, 100e6);
        vm.prank(keeper);
        vm.expectRevert(PerpMarket.NotLiquidatable.selector);
        market.liquidate(alice);
    }

    function test_liquidateUnderwaterPaysNoReward() public {
        _open(alice, true, 1_000e6, 100e6);
        _setPrice(80e8); // equity 100 - 200 < 0
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(usdg.balanceOf(keeper), 0);
    }

    // ------------------------------------------------------------ funding and borrow

    function _fundingOn() internal {
        _params(10, 0, 1000, 5, 1e14, 2_000, 10_000, 5e6);
    }

    function test_fundingIndexAndTotalsWhenLongsPay() public {
        _fundingOn();
        _open(alice, true, 100_000e6, 10_000e6);
        _open(bob, false, 50_000e6, 10_000e6);
        int256 l0 = market.longFundingIndex();
        int256 s0 = market.shortFundingIndex();
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        (uint256 rate, bool longsPay) = market.fundingRate(); // the rate accrue will use
        assertTrue(longsPay);
        assertGt(rate, 0);
        market.accrue();
        uint256 f = rate * 1 hours;
        uint256 light = 100_000e6 * f / 50_000e6;
        assertEq(market.longFundingIndex() - l0, int256(f));
        assertEq(s0 - market.shortFundingIndex(), int256(light));
        assertEq(market.fundingPaidTotal(), 100_000e6 * f);
        assertEq(market.fundingReceivedTotal(), 50_000e6 * light);
    }

    function test_fundingTotalsWhenShortsPay() public {
        _fundingOn();
        _open(alice, true, 50_000e6, 10_000e6);
        _open(bob, false, 100_000e6, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        (uint256 rate, bool longsPay) = market.fundingRate();
        assertFalse(longsPay);
        assertGt(rate, 0);
        market.accrue();
        uint256 f = rate * 1 hours;
        uint256 light = 100_000e6 * f / 50_000e6;
        assertEq(market.fundingPaidTotal(), 100_000e6 * f);
        assertEq(market.fundingReceivedTotal(), 50_000e6 * light);
    }

    function test_newPositionStartsAtItsOwnSideIndex() public {
        _fundingOn();
        _open(alice, true, 100_000e6, 10_000e6);
        _open(bob, false, 50_000e6, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        _open(carol, true, 1_000e6, 100e6);
        _open(dave, false, 1_000e6, 100e6);
        assertTrue(market.longFundingIndex() != market.shortFundingIndex());
        assertEq(market.position(carol).fundingIndex, market.longFundingIndex());
        assertEq(market.position(dave).fundingIndex, market.shortFundingIndex());
        assertEq(market.position(carol).borrowIndex, market.borrowIndex());
    }

    /// exitValueOf (memory fold) must equal what close actually pays (storage fold), for positions opened
    /// after the indices moved, on both sides.
    function test_exitValueOfMatchesClosePayout() public {
        _fundingOn();
        _open(alice, true, 50_000e6, 5_000e6);
        _open(bob, false, 20_000e6, 2_000e6);
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        _open(carol, true, 10_000e6, 2_000e6);
        _open(dave, false, 10_000e6, 2_000e6);
        vm.warp(block.timestamp + 1 hours);
        _setPrice(101e8);
        uint256 vc = market.exitValueOf(carol);
        uint256 vd = market.exitValueOf(dave);
        assertGt(vc, 0);
        assertGt(vd, 0);
        assertEq(_close(carol), vc);
        assertEq(_close(dave), vd);
        (uint256 s, uint256 t,) = _longs();
        assertEq(s, 50_000e6);
        assertEq(t, market.position(alice).tokens);
    }

    /// Partial decreases split accrued funding and borrow pro rata: owed rounds up, received rounds down.
    function test_partialDecreaseSplitsAccruedFundingBothSigns() public {
        _fundingOn();
        _open(alice, true, 100_000e6, 10_000e6); // pays
        _open(bob, false, 50_000e6, 10_000e6); // receives
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        market.accrue();
        vm.prank(alice);
        market.increase(0, 0, 10_000); // folds alice: accrued funding > 0, borrow > 0
        vm.prank(bob);
        market.increase(0, 0, 10_000); // folds bob: accrued funding < 0
        PerpMarket.Position memory a0 = market.position(alice);
        PerpMarket.Position memory b0 = market.position(bob);
        assertGt(a0.accruedFunding, 0);
        assertLt(b0.accruedFunding, 0);
        assertGt(a0.accruedBorrow, 0);

        vm.prank(alice);
        market.decrease(50_000e6);
        vm.prank(bob);
        market.decrease(25_000e6);
        PerpMarket.Position memory a1 = market.position(alice);
        PerpMarket.Position memory b1 = market.position(bob);
        int256 aOut = int256(Math.mulDiv(uint256(a0.accruedFunding), 1, 2, Math.Rounding.Ceil));
        int256 bOut = -int256(uint256(-b0.accruedFunding) / 2);
        assertEq(a1.accruedFunding, a0.accruedFunding - aOut);
        assertEq(b1.accruedFunding, b0.accruedFunding - bOut);
        assertEq(a1.accruedBorrow, a0.accruedBorrow - Math.mulDiv(a0.accruedBorrow, 1, 2, Math.Rounding.Ceil));
    }

    function _liquidationEquity(address who) internal returns (int256 eq) {
        vm.recordLogs();
        vm.prank(keeper);
        market.liquidate(who);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = PerpMarket.Liquidated.selector;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                (, eq,,) = abi.decode(logs[i].data, (uint256, int256, uint256, uint256));
                return eq;
            }
        }
        revert("no Liquidated event");
    }

    /// The views fold the payer's own side index: equityOf and isLiquidatable agree with liquidate.
    function _payerLiquidationViews(bool longsHeavy) internal {
        _fundingOn();
        address payer = longsHeavy ? alice : bob;
        address receiver = longsHeavy ? bob : alice;
        _open(payer, longsHeavy, 60_000e6, 1_500e6);
        _open(receiver, !longsHeavy, 20_000e6, 2_000e6);
        vm.warp(block.timestamp + 1 hours);
        _refresh();
        assertTrue(market.isLiquidatable(payer), "funding pushed the payer under maintenance");
        assertFalse(market.isLiquidatable(receiver));
        int256 view_ = market.equityOf(payer);
        assertEq(_liquidationEquity(payer), view_);
    }

    function test_payerViewsMatchLiquidation_longsPay() public {
        _payerLiquidationViews(true);
    }

    function test_payerViewsMatchLiquidation_shortsPay() public {
        _payerLiquidationViews(false);
    }
}
