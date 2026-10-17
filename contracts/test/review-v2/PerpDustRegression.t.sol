// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "../perps/PerpFixture.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Review v2 (2026-10-16) perps PoCs, turned into regression tests that assert the safe behaviour.
/// The original PoCs (rv2-perps PerpDust.t.sol / PerpStaleSettle.t.sol) passed while the exploit worked.
contract PerpDustRegressionTest is PerpFixture {
    function setUp() public override {
        super.setUp();
        // Mainnet values: taker 10 / maker 6, hold spread 10%, borrow 1 bps/h, default fundingK, OI cap 20%,
        // maxProfit 100%, liquidation fee 5 USDG; guards 40 bps / 30 min / min collateral 100 USDG; min reward 1 USDG.
        _params(10, 6, 1000, 1, 2.78e11, 2_000, 10_000, 5e6);
        harness.setGuardsUnchecked(40, 30 minutes, 100e6);
        assertEq(market.minLiquidationReward(), 1e6);
    }

    function _sybil(uint256 i) internal returns (address a) {
        a = makeAddr(string(abi.encode("sybil", i)));
        vm.prank(a);
        usdg.approve(address(pool), type(uint256).max);
    }

    // ------------------------------------------------------------ V2-M2: dust positions filled every slot

    /// The PoC's moves are refused: a 1-USDG position cannot open (size floor), and a real position cannot be
    /// shrunk to dust (collateral and size floors after a partial decrease). Each slot keeps >= 100 USDG locked.
    function test_V2M2_dustCannotBeCreated() public {
        address s = _sybil(0);
        _fund(s, 1_000e6);
        vm.startPrank(s);
        vm.expectRevert(PerpMarket.SizeTooSmall.selector);
        market.open(true, 1e6, 101e6, 10_000); // the PoC's 1 USDG size (with enough collateral)
        market.open(true, 1_000e6, 200e6, 10_000); // a real position: 1,000 size, 195 USDG kept
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.decrease(1_000e6 - 1); // the PoC: leave 1 unit of size (and ~0.0002 USDG of collateral)
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.decrease(600e6); // would leave 78 USDG of collateral
        market.decrease(400e6); // 600 size and 117 USDG left: fine
        vm.stopPrank();
        PerpMarket.Position memory p = market.position(s);
        assertGe(p.collateral, market.minCollateral());
        assertGe(p.size, market.minCollateral());
        // A full close is always allowed, whatever the floors.
        _close(s);
        assertEq(market.position(s).size, 0);
    }

    /// Filling every slot now locks at least 100 x 100 USDG for as long as the slots are held (the PoC: 0.61 USDG
    /// recycled through 100 sybils), and `retire` empties the market and lets the owner remove it anyway.
    function test_V2M2_slotsCostRealCapitalAndRetireEmptiesTheMarket() public {
        uint256 n = market.MAX_OPEN_POSITIONS();
        uint256 locked;
        for (uint256 i; i < n; i++) {
            address s = _sybil(i);
            _fund(s, 101e6);
            vm.prank(s);
            market.open(i % 2 == 0, 100e6, 101e6, 10_000); // the cheapest slot: 100 size, 100.5 kept
            locked += market.position(s).collateral;
        }
        emit log_named_uint("collateral locked to fill every slot (USDG units)", locked);
        assertGe(locked, n * market.minCollateral());
        // Review v4 R4-PERP-1: a full market of mature 100-size slots refuses only opens under 200; a bigger one
        // displaces the smallest mature position (closed for its owner as its own close would be).
        skip(market.minHoldSeconds());
        _refresh();
        _fund(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 199e6, 1_000e6, 10_000);
        vm.prank(alice);
        market.open(true, 1_000e6, 1_000e6, 10_000);
        assertEq(market.openPositionCount(), n);
        assertEq(market.position(alice).size, 1_000e6);

        // The owner retires the market: opens stop at once, settlement opens after the pool's timelock.
        vm.prank(owner);
        market.retire();
        address[] memory list = market.openPositions();
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotRetired.selector, market.retireAt()));
        market.settleRetired(list[0]);
        skip(pool.TIMELOCK());
        _refresh();
        for (uint256 i; i < list.length; i++) {
            vm.prank(bob); // anyone
            market.settleRetired(list[i]);
        }
        assertEq(market.openInterest(), 0);
        vm.prank(owner);
        pool.removeMarket(address(market));
        assertFalse(pool.isMarket(address(market)));
        // Nobody refills it: a retired market refuses opens.
        _fund(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Retired.selector);
        market.open(true, 1_000e6, 1_000e6, 10_000);
    }

    function test_V2M2_retireIsOwnerOnlyOneWayAndWaitsForAFreshPrice() public {
        _open(alice, true, 1_000e6, 200e6);
        vm.prank(alice);
        vm.expectRevert();
        market.retire();
        vm.startPrank(owner);
        market.retire();
        vm.expectRevert(PerpMarket.Retired.selector);
        market.retire();
        vm.stopPrank();
        _fund(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.Retired.selector);
        market.increase(100e6, 100e6, 10_000);
        skip(pool.TIMELOCK()); // the feed is stale now: settlement waits for a fresh price
        vm.expectRevert(PerpMarket.Hold.selector);
        market.settleRetired(alice);
        _refresh();
        uint256 b = usdg.balanceOf(alice);
        market.settleRetired(alice);
        assertGt(usdg.balanceOf(alice) - b, 185e6, "settled at the oracle price, normal fee, no hold spread");
    }

    // ------------------------------------------------------------ V2-M3: farming the minimum liquidation reward

    /// The PoC's construction (decrease to 20 units, re-lever with collateral == fee) is refused at its first step.
    function test_V2M3_pocConstructionRefused() public {
        address s = _sybil(0);
        _fund(s, 101e6);
        vm.prank(s);
        vm.expectRevert(PerpMarket.SizeTooSmall.selector);
        market.open(true, 1e6, 101e6, 10_000);
        _fund(s, 1_000e6);
        vm.startPrank(s);
        market.open(true, 1_000e6, 200e6, 10_000);
        vm.expectRevert(PerpMarket.CollateralTooLow.selector);
        market.decrease(1_000e6 - 20);
        vm.stopPrank();
    }

    /// The farm at its cheapest legal shape: 100 positions at the floors, 50x, made liquidatable by borrow alone,
    /// liquidated by a sybil. The minimum reward is capped at each position's own collateral, so the LPs never pay
    /// more than the position brought in. Run with a minimum reward ABOVE the minimum collateral (5 > 1 USDG, the
    /// widest the bounds allow) so the cap is what holds: the attacker loses, the LPs do not.
    function test_V2M3_minRewardFarmIsUnprofitable() public {
        vm.startPrank(owner);
        market.proposeGuards(40, 30 minutes, 5e6, 1e6);
        skip(pool.TIMELOCK());
        market.setGuards(40, 30 minutes, 5e6, 1e6);
        vm.stopPrank();
        _refresh();
        address attacker = makeAddr("attacker");
        address liquidator = makeAddr("liq");
        _fund(attacker, 200e6);
        uint256 lpBefore = pool.totalAssets();
        uint256 n = market.MAX_OPEN_POSITIONS();
        address[] memory s = new address[](n);
        for (uint256 i; i < n; i++) {
            s[i] = _sybil(i);
            vm.prank(attacker);
            usdg.transfer(s[i], 1.25e6);
            vm.prank(s[i]);
            market.open(i % 2 == 0, 50e6, 1.25e6, 10_000); // 50 size, 1 USDG kept (fee 0.25): 50x on the floor
        }
        skip(101 hours); // borrow (1 bps/h on size) eats the buffer above maintenance
        _refresh();
        for (uint256 i; i < n; i++) {
            assertTrue(market.isLiquidatable(s[i]));
            uint256 c = market.position(s[i]).collateral;
            uint256 before = usdg.balanceOf(liquidator);
            vm.prank(liquidator);
            market.liquidate(s[i]);
            assertLe(usdg.balanceOf(liquidator) - before, c, "reward never above the position's own collateral");
        }
        int256 attackerPnl = int256(usdg.balanceOf(attacker) + usdg.balanceOf(liquidator)) - 200e6;
        int256 lpPnl = int256(pool.totalAssets()) - int256(lpBefore);
        emit log_named_int("attacker net per cycle (USDG units)", attackerPnl);
        emit log_named_int("LP equity change per cycle (USDG units)", lpPnl);
        assertLt(attackerPnl, 0, "farming the reward loses");
        assertGe(lpPnl, 0, "the LPs do not pay for it");
    }

    /// A gap below zero equity on a position with real collateral still pays the full minimum reward (M-4 kept).
    function test_V2M3_realPositionsStillPayTheMinimumReward() public {
        _open(alice, true, 10_000e6, 1_000e6);
        _setPrice(795e7); // equity about -1,050
        vm.prank(keeper);
        market.liquidate(alice);
        assertEq(usdg.balanceOf(keeper), market.minLiquidationReward());
    }

    // ------------------------------------------------------------ V2-L1: settleHeld on a quiet, just-delisted market

    /// The PoC: a short nobody touched for 6 days is ~900 USDG down; the token is delisted. settleHeld must not open
    /// the moment it is delisted at the week-old price: the hold counts from the delisting.
    function test_V2L1_delistOnQuietMarketDoesNotSettleAtOnce() public {
        _params(10, 2, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, false, 10_000e6, 1_000e6); // short 100 tokens at 100
        skip(6 days);
        _setPrice(109e8); // real price +9%
        registry.delist(address(token));
        assertEq(market.heldFor(), 0, "the hold starts at the delisting, not at the last trade");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, 0));
        market.settleHeld(alice);
        // LP exits wait for the grace like any fresh hold.
        assertTrue(market.staleWithOpenInterest());
        skip(market.HELD_GRACE());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, market.HELD_GRACE()));
        market.settleHeld(alice);
        skip(1);
        market.settleHeld(alice); // only now, 5 days after the delisting, for anyone
        assertEq(market.openInterest(), 0);
    }

    /// The first state-changing call that sees the Valuer revert records it; a poke while listed refreshes the price
    /// time, and a relisting clears the observation.
    function test_V2L1_unpricedObservationRecordedAndCleared() public {
        _open(alice, true, 1_000e6, 200e6);
        _open(bob, false, 1_000e6, 200e6);
        uint256 delistTime = block.timestamp;
        registry.delist(address(token));
        skip(1 days);
        market.poke();
        assertEq(market.unpricedSince(), delistTime, "the observation keeps the delisting time");
        assertEq(market.heldFor(), 1 days);
        // Settling one position never restarts the clock for the next one.
        skip(market.HELD_GRACE());
        market.settleHeld(alice);
        market.settleHeld(bob);
        assertEq(market.openInterest(), 0);
        registry.list(address(token), address(feed), false); // relisting a delisted token waits 48 h
        skip(48 hours);
        registry.list(address(token), address(feed), false);
        _refresh();
        market.poke();
        assertEq(market.unpricedSince(), 0);
        assertEq(market.lastPriceAt(), block.timestamp);
    }

    // ------------------------------------------------------------ V2-L2: parameter floors

    /// The owner can no longer switch the M-3 guard off: spread + 2 x taker must stay above the 50 bps deviation,
    /// and the OI cap is at most 50% of the pool.
    function test_V2L2_roundTripAndOiCapFloors() public {
        PerpMarket m = new PerpMarket(pool, valuer, address(token), owner);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 40, 5));
        m.setParams(5, 5, 1000, 1, 0, 2_000, 10_000, 5e6); // 40 + 10 = 50: not above
        vm.expectRevert(PerpMarket.BadParams.selector);
        m.setParams(10, 6, 1000, 1, 0, 10_000, 10_000, 5e6); // 100% OI cap
        m.proposeParams(10, 6, 1000, 1, 0, 5_000, 10_000, 5e6); // 50%: the maximum
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 30, 6));
        m.setGuards(30, 30 minutes, 1e6, 100e6); // 30 + 2 x 6 (the cheaper maker fee) = 42
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 10, 6));
        m.proposeGuards(10, 5 minutes, 1e6, 100e6); // the review's "switch M-3 off after 48 h"
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 40, 0));
        m.proposeParams(0, 0, 1000, 1, 0, 2_000, 10_000, 5e6);
        vm.stopPrank();
    }

    /// V2-L2 follow-up: makers (treasury desks) pay the maker fee, so the floor uses the cheaper fee. The old mainnet
    /// defaults (spread 40, maker 2: a 44 bps round trip under the 50 bps deviation) are refused; the new ones pass.
    function test_V2L2_makerRoundTripAboveDeviation() public {
        PerpMarket m = new PerpMarket(pool, valuer, address(token), owner);
        assertEq(m.makerFeeBps(), 6);
        assertGt(m.openSpreadBps() + 2 * m.makerFeeBps(), m.FEED_DEVIATION_BPS());
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 40, 2));
        m.proposeParams(10, 2, 1000, 1, 0, 2_000, 10_000, 5e6);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 40, 5));
        m.proposeParams(10, 5, 1000, 1, 0, 2_000, 10_000, 5e6); // 40 + 10 = 50: not above
        m.proposeParams(10, 6, 1000, 1, 0, 2_000, 10_000, 5e6); // 52 bps
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.RoundTripTooCheap.selector, 38, 6));
        m.proposeGuards(38, 30 minutes, 1e6, 100e6); // 38 + 12 = 50 with the 6 bps maker fee
        m.proposeGuards(39, 30 minutes, 1e6, 100e6);
        vm.stopPrank();
    }

    /// The front-running PoC run as a maker at the new defaults: it must lose, and the LPs must not.
    function test_V2L2_makerFrontRunLoses() public {
        PerpMarket fresh = new PerpMarket(pool, valuer, address(token), owner);
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        harness.setGuardsUnchecked(fresh.openSpreadBps(), fresh.minHoldSeconds(), fresh.minCollateral());
        vm.prank(owner);
        pool.proposeMakerRegistrar(address(this));
        skip(pool.TIMELOCK());
        vm.prank(owner);
        pool.setMakerRegistrar(address(this));
        pool.setMaker(alice, true);
        _refresh();
        uint256 lp0 = pool.totalAssets();
        int256 net;
        int256 p = 100e8;
        for (uint256 i; i < 10; i++) {
            _fund(alice, 15_000e6);
            vm.prank(alice);
            market.open(true, 150_000e6, 15_000e6, 10_000);
            p = p * 10_050 / 10_000; // the deviation update the desk saw coming
            _setPrice(p);
            skip(30 minutes); // sit out the minimum hold so the profit is paid
            _setPrice(p);
            net += int256(_close(alice)) - 15_000e6;
        }
        emit log_named_int("maker net over 10 rounds (USDG 6dp)", net);
        assertLt(net, 0, "front-running the update as a maker must lose");
        assertGe(pool.totalAssets(), lp0, "LPs do not pay for it");
    }
}
