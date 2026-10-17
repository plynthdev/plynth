// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PerpFixture} from "./PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

contract PerpMarketTest is PerpFixture {
    // ------------------------------------------------------------ PnL vs reference model

    /// Reference model (independent of the contract's token bookkeeping): a position of `size` USD opened at
    /// p0 is worth size x p1 / p0 at p1. Payout = max(0, collateral - openFee + min(PnL, cap) - closeFee).
    function testFuzz_pnlMatchesReferenceModel(bool isLong, uint256 size, uint256 lev, uint256 p0, uint256 p1)
        public
    {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        size = bound(size, 1e6, 100_000e6);
        lev = bound(lev, 1, 50);
        p0 = bound(p0, 1e8, 10_000e8);
        p1 = bound(p1, p0 / 10, p0 * 10);
        uint256 feeOpen = Math.mulDiv(size, 10, 10_000, Math.Rounding.Ceil);
        uint256 coll = size / lev + feeOpen + 1;

        _setPrice(int256(p0));
        _open(alice, isLong, size, coll);
        _setPrice(int256(p1));
        uint256 got = _close(alice);

        uint256 value = Math.mulDiv(size, p1, p0);
        int256 pnl = isLong ? int256(value) - int256(size) : int256(size) - int256(value);
        if (pnl > int256(size)) pnl = int256(size);
        int256 ref = int256(coll - feeOpen) + pnl - int256(feeOpen);
        if (ref < 0) ref = 0;
        assertApproxEqAbs(got, uint256(ref), 2, "payout vs reference");
    }

    function test_pnl_longAndShortAtTenPercentMove() public {
        _open(alice, true, 1_000e6, 100e6);
        _open(bob, false, 1_000e6, 100e6);
        _setPrice(110e8);
        assertEq(_close(alice), 200e6);
        assertEq(_close(bob), 0); // -100 PnL wipes 100 collateral
    }

    function test_partialDecrease_realizesProportionally() public {
        _open(alice, true, 1_000e6, 200e6);
        _setPrice(110e8);
        uint256 b = usdg.balanceOf(alice);
        vm.prank(alice);
        market.decrease(500e6);
        assertEq(usdg.balanceOf(alice) - b, 150e6); // 100 collateral + 50 PnL
        PerpMarket.Position memory p = market.position(alice);
        assertEq(p.size, 500e6);
        assertEq(p.collateral, 100e6);
        assertEq(p.tokens, 5e18);
    }

    function test_profitCappedAtMaxProfit() public {
        _params(0, 0, 1000, 0, 0, 2_000, 5_000, 5e6);
        _open(alice, true, 1_000e6, 1_000e6);
        _setPrice(300e8);
        assertEq(_close(alice), 1_500e6);
    }

    // ------------------------------------------------------------ leverage, caps, slippage

    function test_open_at50xOk_above50xReverts() public {
        _open(alice, true, 5_000e6, 100e6);
        _fund(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.Leverage.selector);
        market.open(true, 5_000e6 + 1, 100e6, 10_000);
    }

    function test_oiCap_perSidePercentOfPool() public {
        _open(alice, true, 200_000e6, 10_000e6); // exactly 20% of 1M
        _fund(bob, 10_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.OiCap.selector);
        market.open(true, 1e6, 10_000e6, 10_000);
        _open(bob, false, 200_000e6, 10_000e6); // the other side has its own cap
    }

    function test_open_revertsWhenFeeAboveMaxSlippage() public {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.SlippageExceeded.selector, 10, 9));
        market.open(true, 1_000e6, 100e6, 9);
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidation_boundaryExact_long() public {
        _open(alice, true, 1_000e6, 100e6); // 10 tokens, maintenance 10 USDG
        _setPrice(91e8); // equity = 100 + 910 - 1000 = 10 = maintenance
        assertEq(market.equityOf(alice), 10e6);
        assertFalse(market.isLiquidatable(alice));
        vm.prank(keeper);
        vm.expectRevert(PerpMarket.NotLiquidatable.selector);
        market.liquidate(alice);

        _setPrice(9099999999); // one feed tick lower: equity 9.999999
        assertEq(market.equityOf(alice), 10e6 - 1);
        assertTrue(market.isLiquidatable(alice));
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(market.position(alice).size, 0);
    }

    function test_liquidation_boundaryExact_short() public {
        _open(alice, false, 1_000e6, 100e6);
        _setPrice(109e8);
        assertEq(market.equityOf(alice), 10e6);
        assertFalse(market.isLiquidatable(alice));
        _setPrice(10900000001);
        assertEq(market.equityOf(alice), 10e6 - 1);
        assertTrue(market.isLiquidatable(alice));
    }

    function test_liquidate_rewardToCaller_restToPool() public {
        _open(alice, true, 1_000e6, 100e6);
        _setPrice(9099999999);
        uint256 liquid0 = pool.liquidAssets();
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(usdg.balanceOf(keeper), 5e6);
        assertEq(usdg.balanceOf(alice), 0);
        assertEq(pool.liquidAssets(), liquid0 + 100e6 - 5e6);
        assertEq(pool.traderCollateral(), 0);
    }

    function test_liquidate_revertsForSelfAndOperator() public {
        vm.prank(alice);
        pool.setOperator(operator, true);
        _open(alice, true, 1_000e6, 100e6);
        _setPrice(80e8);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.NotAuthorized.selector);
        market.liquidate(alice);
        vm.prank(operator);
        vm.expectRevert(PerpMarket.NotAuthorized.selector);
        market.liquidate(alice);
    }

    // ------------------------------------------------------------ hold

    function test_hold_blocksOpenAndIncrease() public {
        _open(alice, true, 1_000e6, 100e6);
        _hold();
        _fund(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.Hold.selector);
        market.open(true, 1_000e6, 100e6, 10_000);
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Hold.selector);
        market.increase(1e6, 100e6, 10_000);
    }

    function test_hold_allowsAddingMargin() public {
        _open(alice, true, 1_000e6, 100e6);
        _hold();
        _fund(alice, 50e6);
        vm.prank(alice);
        market.increase(0, 50e6, 0);
        assertEq(market.position(alice).collateral, 150e6);
    }

    function test_hold_allowsDecreaseAndCloseAtLastPriceWithSpread() public {
        _open(alice, true, 1_000e6, 500e6);
        _open(bob, false, 1_000e6, 500e6);
        _hold();
        // 10% (the hold spread) against the trader: long exits at 90, short at 110.
        assertEq(_close(alice), 400e6);
        assertEq(_close(bob), 400e6);
    }

    function test_hold_delistedTokenStillCloses() public {
        _open(alice, true, 1_000e6, 500e6);
        registry.delist(address(token));
        assertEq(_close(alice), 400e6);
    }

    // ------------------------------------------------------------ funding and borrow

    function test_fundingRate_isKTimesSkewOverPool() public {
        _params(0, 0, 1000, 0, 2.78e11, 2_000, 10_000, 5e6);
        _open(alice, true, 100_000e6, 100_000e6);
        _open(bob, false, 20_000e6, 20_000e6);
        (uint256 rate, bool longsPay) = market.fundingRate();
        assertTrue(longsPay);
        assertEq(rate, uint256(2.78e11) * 80_000e6 / pool.liquidAssets());
    }

    function test_funding_heavierSidePaysLighter() public {
        _params(0, 0, 1000, 0, 1e13, 2_000, 10_000, 5e6);
        _open(alice, true, 100_000e6, 100_000e6);
        _open(bob, false, 20_000e6, 20_000e6);
        skip(1 days);
        _refresh();
        assertLt(_close(alice), 100_000e6);
        assertGt(_close(bob), 20_000e6);
    }

    function test_funding_noneWhenOneSideEmpty() public {
        _params(0, 0, 1000, 0, 1e13, 2_000, 10_000, 5e6);
        _open(alice, true, 100_000e6, 100_000e6);
        skip(1 days);
        _refresh();
        assertEq(_close(alice), 100_000e6);
    }

    /// Funding conserves: what the heavy side pays equals what the light side receives, up to one base unit
    /// of rounding per position (rounded against traders, kept by the pool).
    function testFuzz_fundingConserves(uint256 a, uint256 b, uint256 c, uint256 dt, uint256 k) public {
        // Sizes within 10x of each other so no receiver hits the profit cap (a capped receipt is forfeited
        // to the pool by design; that is the cap, not a conservation leak).
        a = bound(a, 10_000e6, 100_000e6);
        b = bound(b, 10_000e6, 100_000e6);
        c = bound(c, 1_000e6, 50_000e6);
        dt = bound(dt, 1, 30 days);
        k = bound(k, 1e9, 1e11); // keeps total funding under collateral (1x), so no bad debt muddies the sum
        _params(0, 0, 1000, 0, k, 2_000, 10_000, 5e6);
        _open(alice, true, a, a);
        _open(bob, false, b, b);
        _open(operator, true, c, c);
        skip(dt / 2);
        market.funding();
        skip(dt - dt / 2);
        _refresh();

        uint256 liquid0 = pool.liquidAssets();
        (uint256 paid, uint256 received) = _closeAllAndTally(a, b, c);
        assertGe(paid, received, "receivers never get more than payers pay");
        assertLe(paid - received, 4, "rounding dust only");
        assertEq(pool.liquidAssets() - liquid0, paid - received, "dust stays in pool");
        assertGe(market.fundingPaidTotal(), market.fundingReceivedTotal());
        assertLt(market.fundingPaidTotal() - market.fundingReceivedTotal(), 1e18 * 3);
    }

    function _closeAllAndTally(uint256 a, uint256 b, uint256 c) internal returns (uint256 paid, uint256 received) {
        int256[3] memory d =
            [int256(_close(alice)) - int256(a), int256(_close(bob)) - int256(b), int256(_close(operator)) - int256(c)];
        for (uint256 i; i < 3; i++) {
            if (d[i] < 0) paid += uint256(-d[i]);
            else received += uint256(d[i]);
        }
    }

    function test_borrowFee_perHourToPool() public {
        _params(0, 0, 1000, 10, 0, 2_000, 10_000, 5e6);
        _open(alice, true, 1_000e6, 100e6);
        uint256 liquid0 = pool.liquidAssets();
        skip(1 hours);
        _refresh();
        assertEq(_close(alice), 99e6); // 10 bps of 1,000
        assertEq(pool.liquidAssets(), liquid0 + 1e6);
    }

    // ------------------------------------------------------------ fees: maker tier

    function test_makerFee_onlyForRegisteredAccounts() public {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        address factory = makeAddr("factory");
        _setRegistrar(factory);
        vm.prank(factory);
        pool.setMaker(alice, true);

        _open(alice, true, 1_000e6, 100e6);
        _open(bob, true, 1_000e6, 100e6);
        assertEq(market.position(alice).collateral, 100e6 - 0.2e6);
        assertEq(market.position(bob).collateral, 100e6 - 1e6);
        assertEq(market.feeBpsFor(alice), 2);
        assertEq(market.feeBpsFor(bob), 10);
    }

    function test_setMaker_onlyRegistrar() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.setMaker(alice, true);
        vm.prank(alice);
        vm.expectRevert();
        pool.setMakerRegistrar(alice);
    }

    function test_makerFee_followsAccountNotOperator() public {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        address factory = makeAddr("factory");
        _setRegistrar(factory);
        vm.prank(factory);
        pool.setMaker(operator, true); // the operator being a maker gives the account nothing
        vm.prank(alice);
        pool.setOperator(operator, true);
        _fund(alice, 100e6);
        vm.prank(operator);
        market.openFor(alice, true, 1_000e6, 100e6, 10_000);
        assertEq(market.position(alice).collateral, 99e6);
    }

    /// With LPs in, the registrar changes through the timelock.
    function _setRegistrar(address r) internal {
        vm.prank(owner);
        pool.proposeMakerRegistrar(r);
        skip(pool.TIMELOCK());
        _refresh();
        vm.prank(owner);
        pool.setMakerRegistrar(r);
    }

    // ------------------------------------------------------------ trade-only operators

    function test_operator_opensAndClosesForAccount_proceedsToAccount() public {
        vm.prank(alice);
        pool.setOperator(operator, true);
        _fund(alice, 100e6);
        vm.prank(operator);
        market.openFor(alice, true, 1_000e6, 100e6, 10_000);
        assertEq(usdg.balanceOf(alice), 0, "collateral came from the account");
        _setPrice(110e8);
        vm.prank(operator);
        market.closeFor(alice);
        assertEq(usdg.balanceOf(alice), 200e6);
        assertEq(usdg.balanceOf(operator), 0, "operator never receives");
    }

    function test_operator_cannotWithdrawToItself() public {
        vm.prank(alice);
        pool.setOperator(operator, true);
        _fund(alice, 300e6);
        vm.prank(operator);
        market.openFor(alice, true, 1_000e6, 100e6, 10_000);
        vm.prank(operator);
        market.decreaseFor(alice, 500e6);
        vm.prank(operator);
        market.increaseFor(alice, 0, 100e6, 0);
        vm.prank(operator);
        market.closeFor(alice);
        assertEq(usdg.balanceOf(operator), 0);
        assertEq(usdg.balanceOf(alice), 300e6);

        // LP shares: an operator has no allowance and cannot redeem the account's shares to itself.
        vm.startPrank(alice);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(100e6, alice);
        vm.stopPrank();
        skip(1 days);
        uint256 shares = pool.balanceOf(alice);
        vm.prank(operator);
        vm.expectRevert();
        pool.redeem(shares, operator, alice);
    }

    function test_operator_strangerAndRevokedRejected() public {
        _fund(alice, 100e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.NotAuthorized.selector);
        market.openFor(alice, true, 1_000e6, 100e6, 10_000);

        vm.prank(alice);
        pool.setOperator(operator, true);
        vm.prank(operator);
        market.openFor(alice, true, 1_000e6, 100e6, 10_000);
        vm.prank(alice);
        pool.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(PerpMarket.NotAuthorized.selector);
        market.closeFor(alice);
    }

    // ------------------------------------------------------------ multiplier

    /// Mainnet feeds price one token with the multiplier embedded: a multiplier change alone must not move PnL.
    function test_multiplierChange_embeddedFeed_noPnlJump() public {
        registry.list(address(token), address(feed), true); // a listed token's flag change waits 48 h (ChangeDelay)
        vm.warp(block.timestamp + 48 hours); // ChangeDelay
        registry.list(address(token), address(feed), true);
        vm.warp(block.timestamp - 48 hours);
        feed.set(feed.latestAnswer());
        _open(alice, true, 1_000e6, 100e6);
        int256 e0 = market.equityOf(alice);
        token.setUiMultiplier(1.05e18);
        assertEq(market.equityOf(alice), e0);
        assertEq(_close(alice), 100e6);
    }

    /// Per-share feed (testnet kit): the multiplier is applied once by the Valuer, the position is held in
    /// tokens, so a short of N tokens exactly offsets N tokens held spot through a multiplier change.
    function test_multiplierChange_shortHedgesTokensOneToOne() public {
        uint256 n = 10e18;
        token.mint(alice, n);
        _open(alice, false, 1_000e6, 100e6); // 10 tokens at 100
        assertEq(market.position(alice).tokens, n);
        uint256 start = _spot(n) + uint256(market.equityOf(alice));

        token.setUiMultiplier(1.02e18); // token now worth 102
        assertApproxEqAbs(_spot(n) + uint256(market.equityOf(alice)), start, 1);
        _setPrice(95e8); // and a real move afterwards
        assertApproxEqAbs(_spot(n) + uint256(market.equityOf(alice)), start, 1);
    }

    function _spot(uint256 n) internal view returns (uint256 usd6) {
        (uint256 usd18,) = valuer.value(address(token), n);
        return usd18 / 1e12;
    }

    // ------------------------------------------------------------ admin

    function test_setParams_onlyOwnerAndBounded() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setParams(10, 2, 1000, 1, 0, 2_000, 10_000, 5e6);
        vm.prank(owner);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setParams(10, 11, 1000, 1, 0, 2_000, 10_000, 5e6); // maker above taker
    }
}
