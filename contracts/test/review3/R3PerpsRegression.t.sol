// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "../perps/PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Review v3 (2026-10-17) perps PoCs (wt-review3 R3Perps.t.sol: R3-PERP-1, R3-PERP-6), turned into regression tests
/// that assert the safe behaviour. Mainnet values: taker 10 / maker 6, hold spread 10%, borrow 1 bps/h, fundingK
/// 2.78e11, OI cap 20%, maxProfit 100%, liquidation fee 5 USDG; guards 40 bps / 30 min / min reward 1 / min collateral 100.
contract R3PerpsRegressionTest is PerpFixture {
    function setUp() public override {
        super.setUp();
        _params(10, 6, 1000, 1, 2.78e11, 2_000, 10_000, 5e6);
        harness.setGuardsUnchecked(40, 30 minutes, 100e6);
    }

    function _sybil(uint256 i) internal returns (address a) {
        a = makeAddr(string(abi.encode("r3sybil", i)));
        vm.prank(a);
        usdg.approve(address(pool), type(uint256).max);
    }

    // ------------------------------------------------------------ R3-PERP-1: hedged slot fill

    /// The size floor scales with occupancy: 100 USDG up to the 50th position, doubling every 5 positions after.
    function test_R3P1_slotFloorSchedule() public view {
        assertEq(market.slotFloor(1), 100e6);
        assertEq(market.slotFloor(50), 100e6);
        assertEq(market.slotFloor(51), 200e6);
        assertEq(market.slotFloor(55), 200e6);
        assertEq(market.slotFloor(56), 400e6);
        assertEq(market.slotFloor(100), 102_400e6);
        uint256 total;
        for (uint256 n = 1; n <= market.MAX_OPEN_POSITIONS(); n++) total += market.slotFloor(n);
        assertGe(total, 1_000_000e6, "occupying every slot needs ~1M USDG of size");
    }

    /// The PoC's move: 100 hedged sybils at the old floors (100 size, 100.5 posted). Only the first 50 fit; the 51st
    /// needs twice the size, and an honest trader's ordinary open still goes through.
    function test_R3P1_floorSizedSybilsStopAtHalfTheSlots() public {
        uint256 n = market.MAX_OPEN_POSITIONS();
        uint256 free = market.FREE_SLOTS();
        for (uint256 i; i < n; i++) {
            address s = _sybil(i);
            _fund(s, 100.5e6);
            vm.prank(s);
            if (i < free) {
                market.open(i % 2 == 0, 100e6, 100.5e6, 10_000);
            } else {
                vm.expectRevert(PerpMarket.SizeTooSmall.selector);
                market.open(i % 2 == 0, 100e6, 100.5e6, 10_000);
            }
        }
        assertEq(market.openPositionCount(), market.FREE_SLOTS());
        _fund(alice, 20_000e6);
        vm.prank(alice);
        market.open(true, 20_000e6, 20_000e6, 10_000); // the PoC's blocked honest open
        assertEq(market.position(alice).size, 20_000e6);
    }

    /// Holding every slot for 30 days through +/-20% swings (the PoC) now costs tens of thousands of USDG instead of
    /// 780, and needs a pool deep enough for ~0.5M of size per side under the 20% OI cap.
    function test_R3P1_blockingEveryOpenForAMonthIsUneconomic() public {
        _fund(lp, 5_000_000e6);
        vm.prank(lp);
        pool.deposit(5_000_000e6, lp);
        uint256 n = market.MAX_OPEN_POSITIONS();
        address[] memory s = new address[](n);
        uint256 capital;
        for (uint256 i; i < n; i++) {
            s[i] = _sybil(i);
            uint256 size = market.slotFloor(i + 1);
            uint256 coll = size * 1_005 / 1_000 + 1e6; // fee + spread 0.5%, so the floors hold at 1x
            _fund(s[i], coll);
            capital += coll;
            vm.prank(s[i]);
            market.open(i % 2 == 0, size, coll, 10_000);
        }
        assertEq(market.openPositionCount(), n);
        for (uint256 d; d < 30; d++) {
            skip(1 days);
            _setPrice(d % 2 == 0 ? int256(120e8) : int256(80e8));
        }
        _setPrice(100e8);
        uint256 back;
        for (uint256 i; i < n; i++) {
            back += _close(s[i]);
        }
        uint256 cost = capital - back;
        emit log_named_uint("attacker capital (USDG units)", capital);
        emit log_named_uint("attacker cost for 30 days of a fully blocked market (USDG units)", cost);
        assertGt(capital, 1_000_000e6);
        assertGt(cost, 70_000e6, "a month of blocking every open now costs over 70k USDG (was under 800)");
    }

    /// The floor only binds when a position's size changes: a busier market never traps a position (full close and
    /// margin top-ups work), but a partial decrease must respect the current floor.
    function test_R3P1_busyMarketNeverTrapsAPosition() public {
        _open(alice, true, 150e6, 200e6);
        for (uint256 i; i < 60; i++) {
            address s = _sybil(i);
            uint256 size = market.slotFloor(market.openPositionCount() + 1);
            _fund(s, size * 2);
            vm.prank(s);
            market.open(i % 2 == 0, size, size * 2, 10_000);
        }
        _fund(alice, 100e6);
        vm.prank(alice);
        market.increase(0, 100e6, 10_000); // margin only
        vm.prank(alice);
        vm.expectRevert(PerpMarket.SizeTooSmall.selector);
        market.decrease(10e6); // 140 left under the 61-position floor (400)
        _close(alice);
        assertEq(market.position(alice).size, 0);
    }

    // ------------------------------------------------------------ R3-PERP-6: settleHeld at a stale price

    /// The PoC: no poke for 6 days, the real price +9%, the token delisted. After the grace settleHeld now reads the
    /// token's feed directly and settles at its newer round (109), not at the 6-day-old 100.
    function test_R3P6_settleHeldUsesTheNewerFeedRound() public {
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, false, 10_000e6, 1_000e6); // short 100 tokens at 100
        skip(6 days);
        _setPrice(109e8);
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        uint256 b = usdg.balanceOf(alice);
        vm.prank(alice);
        market.settleHeld(alice);
        uint256 got = usdg.balanceOf(alice) - b;
        emit log_named_uint("alice gets back after the grace (USDG units)", got);
        assertLt(got, 100e6, "settled at 109: the ~900 USDG loss is realized");
    }

    /// With no newer round than the market's own last price (the feed really stopped), settleHeld keeps lastPrice.
    function test_R3P6_noNewerRoundKeepsTheLastPrice() public {
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, false, 10_000e6, 1_000e6);
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        uint256 b = usdg.balanceOf(alice);
        market.settleHeld(alice);
        assertGt(usdg.balanceOf(alice) - b, 900e6, "flat price: collateral back minus fees");
    }

    /// A feed round stamped in the future, or a non-positive answer, is ignored (lastPrice stays).
    function test_R3P6_badFeedRoundIgnored() public {
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        _open(alice, false, 10_000e6, 1_000e6);
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        _setPrice(0);
        uint256 b = usdg.balanceOf(alice);
        market.settleHeld(alice);
        assertGt(usdg.balanceOf(alice) - b, 900e6);
    }
}
