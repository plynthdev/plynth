// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "./PerpFixture.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Findings of the 2026-10 external audit (perps: M-2, M-3, M-4), each as a PoC that failed before its fix.
contract PerpAuditTest is PerpFixture {
    // ------------------------------------------------------------ M-2: a held market froze every LP exit

    /// The audit's PoC: one 1-USDG position on a market whose feed halts. Before the fix LP redeem reverted
    /// MarketOnHold forever; now it waits only HELD_GRACE.
    function test_M2_feedHalt30Days_lpRedeemWorksAfterGrace() public {
        _open(alice, true, 1e6, 1e6);
        skip(30 days); // the feed never updates again
        assertTrue(_onHold(), "feed is stale");
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.redeem(shares / 10, lp, lp);
        assertGt(usdg.balanceOf(lp), 0, "LP got out");
    }

    /// Same with the token delisted (Valuer.quote reverts) for a year.
    function test_M2_delistedForAYear_lpRedeemWorks() public {
        _open(alice, true, 1e6, 1e6);
        registry.delist(address(token));
        skip(365 days);
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.redeem(shares / 10, lp, lp);
        assertGt(usdg.balanceOf(lp), 0, "LP got out");
    }

    /// Within the grace the S11 rule still holds: no LP exit at a stale share price.
    function test_M2_withinGraceExitsStillWait() public {
        _open(alice, true, 1e6, 1e6);
        skip(market.HELD_GRACE()); // exactly the grace: not past it
        assertTrue(market.staleWithOpenInterest());
        assertEq(pool.maxRedeem(lp), 0);
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.MarketOnHold.selector, address(market)));
        pool.redeem(shares / 10, lp, lp);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, market.HELD_GRACE()));
        market.settleHeld(alice);
    }

    /// Past the grace the held market is valued at its reserve (every position at its maximum payout), so an
    /// LP leaving then cannot leave a loss behind; deposits stay closed (that price would gift entrants).
    function test_M2_pastGraceValuationIsTheReserve() public {
        _open(alice, true, 100_000e6, 10_000e6);
        skip(market.HELD_GRACE() + 1);
        assertFalse(market.staleWithOpenInterest());
        assertTrue(market.onHoldWithOpenInterest());
        assertEq(market.traderPnl(), int256(market.reserve()));
        assertEq(pool.totalAssets(), pool.liquidAssets() - market.reserve());
        assertEq(pool.maxDeposit(bob), 0);
        _fund(bob, 1_000e6);
        vm.startPrank(bob);
        usdg.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.MarketOnHold.selector, address(market)));
        pool.deposit(1_000e6, bob);
        vm.stopPrank();
    }

    /// Feed halted 30 days: anyone settles the position at the last price (no hold spread), OI reaches 0, the
    /// pool is whole again and the owner can drop the market.
    function test_M2_feedHalt30Days_settleHeldClosesAtLastPrice() public {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, true, 1_000e6, 500e6); // 10 tokens at 100, 1 USDG fee
        skip(30 days);
        vm.prank(bob); // a stranger: neither the account nor its operator
        market.settleHeld(alice);
        assertEq(usdg.balanceOf(alice), 499e6 - 1e6, "collateral back minus the close fee, no 10% hold spread");
        assertEq(market.position(alice).size, 0);
        assertEq(market.openInterest(), 0);
        assertFalse(market.onHoldWithOpenInterest());
        vm.prank(owner);
        pool.removeMarket(address(market));
        assertEq(pool.markets().length, 0);
        assertFalse(pool.isMarket(address(market)));
        _fund(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.Hold.selector); // and nothing can open on it (stale; and the pool refuses it)
        market.open(true, 100e6, 100e6, 10_000);
    }

    /// Token delisted for a year: the Valuer reverts, the stored price time drives the grace.
    function test_M2_delistedForAYear_settleHeldAndRemove() public {
        _open(alice, false, 1e6, 1e6);
        registry.delist(address(token));
        skip(365 days);
        market.settleHeld(alice);
        assertEq(market.openInterest(), 0);
        vm.prank(alice);
        vm.expectRevert();
        pool.removeMarket(address(market)); // owner only
        vm.prank(owner);
        pool.removeMarket(address(market));
        _fund(bob, 1_000e6);
        vm.startPrank(bob);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(1_000e6, bob); // deposits reopen with the market gone
        vm.stopPrank();
    }

    function test_M2_settleHeldProfitCappedAndNotOnAFreshMarket() public {
        _params(0, 0, 1000, 0, 0, 2_000, 5_000, 5e6);
        _open(alice, true, 1_000e6, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, 0));
        market.settleHeld(alice); // a fresh market: never
        _setPrice(300e8);
        skip(6 days);
        market.settleHeld(alice);
        assertEq(usdg.balanceOf(alice), 1_500e6, "profit capped at maxProfitBps like a normal close");
    }

    function test_M2_removeMarketRefusedWithOpenInterest() public {
        _open(alice, true, 1e6, 1e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.OpenInterest.selector, address(market)));
        pool.removeMarket(address(market));
        vm.prank(owner);
        vm.expectRevert(PerpPool.NotMarket.selector);
        pool.removeMarket(alice);
    }

    /// poke() records a fresh price time, so a later delisting counts its grace from then.
    function test_M2_pokeRecordsThePriceTime() public {
        _open(alice, true, 1e6, 1e6);
        skip(10 days);
        _refresh();
        market.poke();
        assertEq(market.lastPriceAt(), block.timestamp);
        registry.delist(address(token));
        skip(market.HELD_GRACE());
        assertTrue(market.staleWithOpenInterest(), "grace counts from the poke");
        skip(1);
        assertFalse(market.staleWithOpenInterest());
    }

    // ------------------------------------------------------------ M-3: front-running the oracle update

    /// The audit's PoC: the trader sees the real price 0.5% (the feeds' deviation threshold) above the feed,
    /// opens just before the deviation update lands and closes right after. 10 rounds netted +4,500 USDG from
    /// the LPs. With the open spread and the minimum hold it must lose, and the LPs must not.
    function test_M3_frontRunDeviationUpdate_tenRoundsLoses() public {
        _productionGuards();
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        uint256 lp0 = pool.totalAssets();
        int256 net = _frontRun(0);
        emit log_named_int("trader net over 10 rounds (USDG 6dp)", net);
        assertLt(net, 0, "front-running the update must lose");
        assertGe(pool.totalAssets(), lp0, "LPs do not pay for it");
    }

    /// Same, but the trader sits out the minimum hold after the update (price unchanged) before closing: the
    /// open spread plus the fees still exceed the 0.5% the trader knew in advance.
    function test_M3_frontRunAndWaitOutTheHold_stillLoses() public {
        _productionGuards();
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        uint256 lp0 = pool.totalAssets();
        int256 net = _frontRun(30 minutes);
        emit log_named_int("trader net over 10 rounds (USDG 6dp)", net);
        assertLt(net, 0);
        assertGe(pool.totalAssets(), lp0);
    }

    function test_M3_spreadChargedOnSizeAndCountsAsSlippage() public {
        _productionGuards();
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        uint256 cost = 10 + market.openSpreadBps();
        _fund(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.SlippageExceeded.selector, cost, cost - 1));
        market.open(true, 10_000e6, 1_000e6, cost - 1);
        vm.prank(alice);
        market.open(true, 10_000e6, 1_000e6, cost);
        PerpMarket.Position memory p = market.position(alice);
        assertEq(p.collateral, 1_000e6 - 10_000e6 * cost / 10_000);
        assertEq(p.tokens, 100e18, "tokens stay size / oracle price (1:1 hedges)");
        assertEq(p.openedAt, block.timestamp);
    }

    /// Inside the hold a loss is realized in full but a profit is not paid; after it, it is.
    function test_M3_minHoldCapsProfitNotLoss() public {
        _productionGuards();
        uint256 spreadFee = 1_000e6 * market.openSpreadBps() / 10_000;
        _open(alice, true, 1_000e6, 200e6);
        _open(bob, false, 1_000e6, 200e6);
        _setPrice(105e8);
        assertEq(market.exitValueOf(alice), 200e6 - spreadFee, "a young winner is valued without its profit");
        assertEq(_close(alice), 200e6 - spreadFee, "profit capped at 0");
        assertEq(_close(bob), 200e6 - spreadFee - 50e6, "the loss is realized in full");

        _open(alice, true, 1_000e6, 200e6);
        skip(market.minHoldSeconds());
        _setPrice(110e8);
        assertEq(_close(alice), 200e6 - spreadFee + 47_619_047, "past the hold the profit is paid (10/105)");
    }

    function test_M3_increaseRestartsTheHoldButMarginDoesNot() public {
        _productionGuards();
        _open(alice, true, 1_000e6, 200e6);
        skip(market.minHoldSeconds());
        _fund(alice, 100e6);
        vm.prank(alice);
        market.increase(0, 100e6, 0); // margin only
        assertEq(market.position(alice).openedAt, block.timestamp - market.minHoldSeconds());
        _fund(alice, 1e6);
        vm.prank(alice);
        market.increase(1e6, 1e6, 10_000); // any size restarts the clock
        assertEq(market.position(alice).openedAt, block.timestamp);
        _setPrice(110e8);
        uint256 coll = market.position(alice).collateral;
        assertEq(_close(alice), coll, "young again: no profit");
    }

    function test_M3_liquidationIgnoresTheHold() public {
        _productionGuards();
        _open(alice, true, 1_000e6, 110e6);
        _setPrice(80e8);
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(market.position(alice).size, 0);
    }

    function test_M3_guardsBounded() public {
        _params(25, 25, 1000, 0, 0, 2_000, 10_000, 5e6); // 10 bps spread + 2 x 25 bps fee: above the 50 bps deviation
        vm.startPrank(owner);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(9, 30 minutes, 1e6, 100e6);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(301, 30 minutes, 1e6, 100e6);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(40, 5 minutes - 1, 1e6, 100e6);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(40, 1 days + 1, 1e6, 100e6);
        market.proposeGuards(10, 5 minutes, 1e6, 100e6);
        skip(pool.TIMELOCK());
        market.setGuards(10, 5 minutes, 1e6, 100e6);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        market.setGuards(40, 30 minutes, 1e6, 100e6);
        assertEq(market.openSpreadBps(), 10);
    }

    function _frontRun(uint256 wait) internal returns (int256 net) {
        int256 p = 100e8;
        for (uint256 i; i < 10; i++) {
            _fund(alice, 15_000e6);
            vm.prank(alice);
            market.open(true, 150_000e6, 15_000e6, 10_000);
            p = p * 10_050 / 10_000; // the deviation update the trader saw coming
            _setPrice(p);
            if (wait != 0) {
                skip(wait);
                _refresh();
            }
            net += int256(_close(alice)) - 15_000e6;
        }
    }

    /// The front-running guards at the contract's production defaults (the fixture turns them off).
    function _productionGuards() internal {
        PerpMarket fresh = new PerpMarket(pool, valuer, address(token), owner);
        harness.setGuardsUnchecked(fresh.openSpreadBps(), fresh.minHoldSeconds(), fresh.minCollateral());
    }

    // ------------------------------------------------------------ M-4: underwater positions and bad debt

    /// The audit's PoC: a gap takes a 10x long below zero equity (-1,050). The reward was min(fee, equity) = 0,
    /// so nobody liquidated, and the trader kept a free option: on a recovery it closes for 950 instead of
    /// losing 1,050. A third party must now profit by liquidating it.
    function test_M4_underwaterPositionPaysALiquidator() public {
        _open(alice, true, 10_000e6, 1_000e6); // 100 tokens at 100
        _setPrice(795e7); // gap: PnL -2,050, equity -1,050
        assertEq(market.equityOf(alice), -1_050e6);
        assertTrue(market.isLiquidatable(alice));
        vm.prank(keeper);
        market.liquidate(alice);
        assertGt(usdg.balanceOf(keeper), 0, "the liquidator is paid even below zero equity");
        assertEq(market.position(alice).size, 0, "no free option left");
    }

    /// The audit's PoC: netting PnL per side hid one long's bad debt behind another long's gain. Bob is long
    /// from 50 (+3,500 at 85), Alice from 100 (-1,500 on 1,000 collateral: 500 of bad debt). LP equity must
    /// count Alice at -1,000 (her collateral), not -1,500: the per-side sum overstated it by 500.
    function test_M4_lpEquityFloorsEachPosition() public {
        _setPrice(50e8);
        _open(bob, true, 5_000e6, 1_000e6);
        _setPrice(100e8);
        _open(alice, true, 10_000e6, 1_000e6);
        _setPrice(85e8);
        assertEq(market.traderPnl(), 3_500e6 - 1_000e6);
        assertEq(pool.totalAssets(), pool.liquidAssets() - 2_500e6);
    }

    function test_M4_minRewardExactAndPaidByThePool() public {
        _open(alice, true, 10_000e6, 1_000e6);
        _setPrice(795e7);
        uint256 liquid0 = pool.liquidAssets();
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(usdg.balanceOf(keeper), market.minLiquidationReward());
        assertEq(market.minLiquidationReward(), 1e6);
        assertEq(pool.liquidAssets(), liquid0 + 1_000e6 - 1e6, "the collateral to LPs, the reward out of the pool");
    }

    /// Equity above zero but below the minimum reward: still the minimum.
    function test_M4_rewardNeverBelowTheMinimum() public {
        _open(alice, true, 10_000e6, 1_000e6);
        _setPrice(90_005e5); // equity 0.5 USDG, maintenance 100
        assertEq(market.equityOf(alice), 0.5e6);
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(usdg.balanceOf(keeper), 1e6);
    }

    function test_M4_minRewardBoundedByTheFee() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(40, 30 minutes, 5e6 + 1, 100e6); // above liquidationFee
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setGuards(40, 30 minutes, 1e6 - 1, 100e6); // below one unit
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setParams(0, 0, 1000, 0, 0, 2_000, 10_000, 1e6 - 1); // fee below the minimum reward
        vm.stopPrank();
    }

    function test_M4_minCollateralOnOpen() public {
        _productionGuards();
        assertEq(market.minCollateral(), 100e6);
        uint256 fee = 1_000e6 * market.openSpreadBps() / 10_000; // taker 0 in the fixture
        _fund(alice, 100e6 + fee);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.open(true, 1_000e6, 100e6 - 1, 10_000);
        // Review v2 M-2: the minimum is what the position keeps, so the fee comes on top.
        vm.prank(alice);
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.open(true, 1_000e6, 100e6, 10_000);
        vm.prank(alice);
        market.open(true, 1_000e6, 100e6 + fee, 10_000);
        assertEq(market.position(alice).collateral, 100e6);
    }

    /// The per-position valuation needs a bounded set: MAX_OPEN_POSITIONS per market, a slot frees on close.
    function test_M4_openPositionsBoundedAndEnumerable() public {
        uint256 max = market.MAX_OPEN_POSITIONS();
        _fill(max);
        assertEq(market.openPositionCount(), max);
        address[] memory list = market.openPositions();
        assertEq(list.length, max);
        assertEq(list[0], _trader(0));
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 100e6, 100e6, 10_000);
        _close(_trader(7));
        vm.prank(alice);
        market.open(true, 100e6, 100e6, 10_000);
        assertEq(market.openPositionCount(), max);
    }

    /// Gas of one share-price read with a full market, cold (as the first read of a deposit or redeem is).
    function test_M4_totalAssetsGasWithAFullMarket() public {
        _fill(market.MAX_OPEN_POSITIONS());
        _setPrice(97e8);
        vm.cool(address(market));
        vm.cool(address(pool));
        vm.cool(address(usdg));
        uint256 g = gasleft();
        pool.totalAssets();
        g -= gasleft();
        emit log_named_uint("totalAssets gas, 100 positions, cold", g);
        assertLt(g, 1_250_000, "one full market stays near 1M gas");
    }

    /// Independent check: traderPnl equals the per-position clamped sum.
    function testFuzz_M4_traderPnlIsThePerPositionSum(uint256 p1) public {
        p1 = bound(p1, 10e8, 300e8);
        for (uint256 i; i < 10; i++) {
            _setPrice(int256(50e8 + i * 15e8));
            vm.prank(_trader(i));
            usdg.approve(address(pool), type(uint256).max);
            _open(_trader(i), i % 2 == 0, (i + 1) * 1_000e6, (i + 1) * 120e6);
        }
        _setPrice(int256(p1));
        int256 sum;
        for (uint256 i; i < 10; i++) {
            PerpMarket.Position memory q = market.position(_trader(i));
            int256 v = int256(q.tokens * p1 * 1e10 / 1e30);
            v = q.isLong ? v - int256(q.size) : int256(q.size) - v;
            if (v > int256(q.size)) v = int256(q.size);
            if (v < -int256(q.collateral)) v = -int256(q.collateral);
            sum += v;
        }
        assertApproxEqAbs(market.traderPnl(), sum, 10);
    }

    // ------------------------------------------------------------ privileged changes took effect instantly

    /// With LPs in, listing a market (a new counterparty exposure for every LP) waits the timelock.
    function test_timelock_addMarketWithLpsIsNotInstant() public {
        PerpMarket m2 = new PerpMarket(pool, valuer, address(token), owner);
        bytes32 id = pool.marketId(address(m2));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.TimelockActive.selector, id, 0));
        pool.addMarket(address(m2));
        pool.proposeMarket(address(m2));
        uint256 eta = block.timestamp + pool.TIMELOCK();
        assertEq(pool.etaOf(id), eta);
        skip(pool.TIMELOCK() - 1);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.TimelockActive.selector, id, eta));
        pool.addMarket(address(m2));
        skip(1);
        pool.addMarket(address(m2));
        vm.stopPrank();
        assertTrue(pool.isMarket(address(m2)));
        assertEq(pool.etaOf(id), 0, "the proposal is used up");
    }

    /// The maker registrar sets who pays the 2 bps maker fee instead of 10: LP income, so timelocked too.
    /// Clearing it (no new makers) is instant.
    function test_timelock_makerRegistrarWithLpsIsNotInstant() public {
        bytes32 id = pool.registrarId(alice);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.TimelockActive.selector, id, 0));
        pool.setMakerRegistrar(alice);
        pool.proposeMakerRegistrar(alice);
        skip(pool.TIMELOCK());
        pool.setMakerRegistrar(alice);
        assertEq(pool.makerRegistrar(), alice);
        pool.setMakerRegistrar(address(0));
        assertEq(pool.makerRegistrar(), address(0));
        vm.stopPrank();
    }

    /// A listed market with LPs: raising the borrow fee (or any risk-increasing param) waits the timelock.
    function test_timelock_setParamsOnALiveMarketIsNotInstant() public {
        _params(30, 30, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, true, 1_000e6, 100e6);
        PerpMarket.Params memory p = PerpMarket.Params(30, 30, 1000, 100, 0, 2_000, 10_000, 5e6);
        bytes32 id = market.paramsId(p);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.TimelockActive.selector, id, 0));
        market.setParams(30, 30, 1000, 100, 0, 2_000, 10_000, 5e6);
        market.proposeParams(30, 30, 1000, 100, 0, 2_000, 10_000, 5e6);
        vm.stopPrank();
        skip(pool.TIMELOCK());
        _refresh();
        vm.startPrank(owner);
        vm.expectRevert(); // only exactly the proposed values
        market.setParams(30, 30, 1000, 99, 0, 2_000, 10_000, 5e6);
        market.setParams(30, 30, 1000, 100, 0, 2_000, 10_000, 5e6);
        vm.stopPrank();
        assertEq(market.borrowBpsPerHour(), 100);
    }

    /// Lowering the OI cap only refuses new opens: instant. Raising it is not.
    function test_timelock_lowerOiCapIsInstant() public {
        _params(30, 30, 1000, 0, 0, 2_000, 10_000, 5e6);
        vm.startPrank(owner);
        market.setParams(30, 30, 1000, 0, 0, 1_000, 10_000, 5e6);
        assertEq(market.oiCapBps(), 1_000);
        vm.expectRevert();
        market.setParams(30, 30, 1000, 0, 0, 2_000, 10_000, 5e6);
        vm.stopPrank();
    }

    /// Raising the open spread or the minimum collateral only makes new opens dearer: instant. The hold and the
    /// minimum reward wait the timelock; a proposal can be cancelled.
    function test_timelock_guards() public {
        _productionGuards();
        vm.startPrank(owner);
        market.setGuards(100, 30 minutes, 1e6, 200e6);
        assertEq(market.openSpreadBps(), 100);
        assertEq(market.minCollateral(), 200e6);
        PerpMarket.Guards memory g = PerpMarket.Guards(100, 1 hours, 1e6, 200e6);
        bytes32 id = market.guardsId(g);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.TimelockActive.selector, id, 0));
        market.setGuards(100, 1 hours, 1e6, 200e6);
        market.proposeGuards(100, 1 hours, 1e6, 200e6);
        market.cancel(id);
        assertEq(market.etaOf(id), 0);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotProposed.selector, id));
        market.cancel(id);
        market.proposeGuards(100, 1 hours, 1e6, 200e6);
        skip(pool.TIMELOCK());
        market.setGuards(100, 1 hours, 1e6, 200e6);
        vm.stopPrank();
        assertEq(market.minHoldSeconds(), 1 hours);
    }

    /// Before any LP share or position nothing can be hurt: the deploy script configures everything at once.
    function test_timelock_instantBeforeAnyLp() public {
        PerpPool p2 = new PerpPool(usdg, owner, 24 hours, 48 hours);
        PerpMarket m2 = new PerpMarket(p2, valuer, address(token), owner);
        vm.startPrank(owner);
        m2.setParams(10, 6, 1000, 1, 0, 2_000, 10_000, 5e6);
        m2.setGuards(50, 1 hours, 2e6, 50e6);
        p2.addMarket(address(m2));
        p2.openDeposits();
        p2.setMakerRegistrar(alice);
        m2.setParams(10, 6, 1000, 1, 0, 3_000, 10_000, 5e6);
        vm.stopPrank();
        assertEq(m2.oiCapBps(), 3_000);
        vm.prank(alice);
        vm.expectRevert();
        m2.proposeParams(10, 6, 1000, 1, 0, 3_000, 10_000, 5e6); // owner only
        vm.prank(alice);
        vm.expectRevert();
        p2.proposeMarket(alice);
    }

    function test_timelock_hasAFloor() public {
        vm.expectRevert(PerpPool.TimelockTooShort.selector);
        new PerpPool(usdg, owner, 24 hours, 10 minutes - 1);
        assertEq(new PerpPool(usdg, owner, 24 hours, 10 minutes).TIMELOCK(), 10 minutes);
    }

    function _trader(uint256 i) internal pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    function _fill(uint256 n) internal {
        for (uint256 i; i < n; i++) {
            address t = _trader(i);
            vm.prank(t);
            usdg.approve(address(pool), type(uint256).max);
            _open(t, i % 2 == 0, 1_000e6, 100e6);
        }
    }

    function _onHold() internal view returns (bool hold) {
        (, hold) = market.price();
    }
}
