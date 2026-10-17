// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RV3PerpMainnet} from "../review-v3/RV3PerpMainnet.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Review v4 (2026-10-17) R4-PERP-1 PoC (wt-review4 R4PerpSlotFloorPartial.t.sol), turned into regression tests that
/// assert the safe behaviour, on the no-harness mainnet fixture (real PerpMarket / PerpPool wired as MainnetBeta
/// wires them, the real Valuer with the NYSE calendar, 1M LP). The occupancy floor is gone: newcomers and trims keep
/// the base floors, and a full market admits any open of DISPLACE_FACTOR times its smallest position.
contract R4PerpSlotRegressionTest is RV3PerpMainnet {
    address[] internal sybils;

    function _fill(uint256 n, uint256 size) internal returns (uint256 capital) {
        for (uint256 i; i < n; i++) {
            address s = _trader(string(abi.encode("r4sybil", sybils.length)));
            sybils.push(s);
            uint256 coll = size * 1_006 / 1_000 + 1e6; // 1x plus fee + spread
            capital += coll;
            _open(s, i % 2 == 0, size, coll);
        }
    }

    function _hold30DaysAndUnwind() internal returns (uint256 back) {
        for (uint256 d; d < 30; d++) {
            skip(1 days);
            feed.set(P0);
        }
        assertFalse(valuer.marketClosed(), "unwind on an open market (Thu 2026-12-10 14:00 UTC)");
        for (uint256 i; i < sybils.length; i++) {
            uint256 b = usdg.balanceOf(sybils[i]);
            vm.prank(sybils[i]);
            market.close();
            back += usdg.balanceOf(sybils[i]) - b;
        }
    }

    /// The PoC: an honest 2,000 position, then 69 hedged sybils. A retail 3,000 open goes through, and the honest
    /// position trims 2,000 -> 1,000: nobody's floor moved.
    function test_R4P1_sixtyNineSybilsNoLongerPriceRetailOut() public {
        address carol = _trader("carol");
        _open(carol, true, 2_000e6, 400e6);
        _fill(69, 100e6);
        assertEq(market.openPositionCount(), 70);
        address bob = _trader("bob");
        _open(bob, true, 3_000e6, 1_000e6);
        address dave = _trader("dave");
        _open(dave, false, 100e6, 101e6); // even a floor-sized open
        vm.prank(carol);
        market.decrease(1_000e6);
        assertEq(market.position(carol).size, 1_000e6);
    }

    /// Filling every slot at the floor (the old 780 USDG / month attack) keeps out only opens under 200 USDG: a 200
    /// open displaces the smallest sybil.
    function _mature() internal {
        skip(market.minHoldSeconds());
        feed.set(P0);
    }

    function test_R4P1_fullFloorMarketExcludesOnlyOpensUnderTwiceTheFloor() public {
        _fill(100, 100e6);
        _mature();
        address bob = _trader("bob");
        usdg.mint(bob, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 200e6 - 1, 1_000e6, 10_000);
        vm.prank(bob);
        market.open(true, 200e6, 1_000e6, 10_000);
        assertEq(market.openPositionCount(), 100);
    }

    /// Griefing cost scales with impact: keeping every open under 14,000 USDG out of a market for 30 days needs 7,000
    /// in each of the 100 slots (700k of open interest under the OI cap) and costs over 50k USDG; an open of 14,000 is
    /// still admitted.
    function test_R4P1_excludingRetailUnder14kCostsOver50kAMonth() public {
        usdg.mint(lp, 2_000_000e6);
        vm.prank(lp);
        pool.deposit(2_000_000e6, lp); // room for 350k per side under the 20% OI cap
        uint256 capital = _fill(100, 7_000e6);
        _mature();
        address bob = _trader("bob");
        usdg.mint(bob, 20_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 14_000e6 - 1, 20_000e6, 10_000);
        uint256 back = _hold30DaysAndUnwind();
        uint256 cost = capital - back;
        emit log_named_uint("cost of 30 days keeping every open under 14,000 out (USDG units)", cost);
        assertGt(cost, 50_000e6, "griefing retail under 14k costs over 50k USDG a month");
    }

    function test_R4P1_fullMarketAdmitsTheThresholdOpen() public {
        usdg.mint(lp, 2_000_000e6);
        vm.prank(lp);
        pool.deposit(2_000_000e6, lp);
        _fill(100, 7_000e6);
        _mature();
        address bob = _trader("bob");
        _open(bob, true, 14_000e6, 20_000e6);
        assertEq(market.position(bob).size, 14_000e6);
        assertEq(market.openPositionCount(), 100);
    }

    /// The other way to keep a full market closed: keep every slot inside its minimum hold, so none is displaceable.
    /// That needs an increase of at least minCollateral (100 USDG) every 30 minutes per slot (taken back out with a
    /// partial decrease): measured on 10 slots for one day, then scaled to 100 slots and 30 days. Over 50k a month.
    function test_R4P1_keepingEverySlotYoungCostsOver50kAMonth() public {
        uint256 capital = _fill(10, 1_000e6);
        uint256 spent;
        uint256 hold = market.minHoldSeconds();
        for (uint256 t; t < 1 days; t += hold - 1 minutes) {
            skip(hold - 1 minutes);
            feed.set(P0);
            for (uint256 i; i < sybils.length; i++) {
                address s = sybils[i];
                uint256 b = usdg.balanceOf(s);
                usdg.mint(s, 101e6);
                vm.prank(s);
                market.increase(100e6, 101e6, 10_000); // 1x on the increment, fee and spread included
                vm.prank(s);
                market.decrease(100e6);
                spent += b + 101e6 - usdg.balanceOf(s); // net of the collateral the decrease returned
            }
        }
        uint256 back;
        for (uint256 i; i < sybils.length; i++) {
            uint256 b = usdg.balanceOf(sybils[i]);
            vm.prank(sybils[i]);
            market.close();
            back += usdg.balanceOf(sybils[i]) - b;
        }
        uint256 perSlotDay = (capital - back + spent) / sybils.length;
        uint256 month = perSlotDay * 100 * 30;
        emit log_named_uint("keep-young cost per slot per day (USDG units)", perSlotDay);
        emit log_named_uint("keep-young cost, 100 slots, 30 days (USDG units)", month);
        assertGt(month, 50_000e6);
    }
}
