// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasisSleeveTest} from "../treasury/sleeves/BasisSleeve.t.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {PerpMarketHarness} from "../perps/PerpMarketHarness.sol";

/// Review v5 (2026-10-17) R5-PERP-1 PoC (wt-review5 R5BasisDisplacedStranded.t.sol), perps part, turned into
/// regression tests that assert the safe behaviour: a registered maker's position (an in-house treasury venue) is
/// never displaced, and makers can hold at most MAX_MAKER_POSITIONS of a market's slots. (The venue idle-cash sweep is
/// the treasury lane's fix.) Real BasisSleeve, InHousePerpVenue and PerpPool; the harness market with the production
/// guards put back.
contract R5PerpDisplacementRegressionTest is BasisSleeveTest {
    function _fund(address a, uint256 amt) internal {
        usdg.mint(a, amt);
        vm.prank(a);
        usdg.approve(address(pool), type(uint256).max);
    }

    /// OWNER (the maker registrar on mainnet) registers the treasury's in-house venue as a maker.
    function _registerVenueAsMaker() internal {
        pool.proposeMakerRegistrar(address(this));
        _warpAll(block.timestamp + pool.TIMELOCK());
        pool.setMakerRegistrar(address(this));
        pool.setMaker(address(venue), true);
    }

    function _fillYoung(uint256 n) internal returns (uint256 spent) {
        for (uint256 i; i < n; i++) {
            address s = address(uint160(0x5e000 + i));
            _fund(s, 101e6);
            spent += 101e6;
            vm.prank(s);
            market.open(i % 2 == 0, 100e6, 101e6, 100);
        }
    }

    /// The PoC's sequence: the stranger fills the free slots with young 100-USDG positions and opens twice the
    /// treasury short. The short is a maker's: it is not displaceable, so the open has nothing to displace and reverts.
    function test_R5P1_strangerCannotDisplaceATreasuryBasisShort() public {
        PerpMarketHarness(address(market)).setGuardsUnchecked(40, 30 minutes, 100e6);
        _registerVenueAsMaker();
        vm.prank(crowd2);
        market.open(true, 150_000e6, 30_000e6, 100);
        _openPair(address(aapl), 100_000e6, 50_000e6);
        assertTrue(market.position(address(venue)).maker);
        assertEq(market.makerPositions(), 1);
        _warpAll(block.timestamp + 31 minutes);
        _fillYoung(98);
        assertEq(market.openPositionCount(), 100);
        (address smallest, uint256 s) = market.smallestMaturePosition();
        assertEq(smallest, crowd2, "the treasury short is not a displacement candidate");
        assertEq(s, 150_000e6);
        address whale = makeAddr("whale");
        _fund(whale, 60_000e6);
        vm.prank(whale);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 200_000e6, 40_000e6, 100); // 2x the short: refused
        assertEq(market.position(address(venue)).size, 100_000e6, "the treasury hedge stays open");
    }

    /// Makers hold at most MAX_MAKER_POSITIONS slots of a market (so maker positions cannot fill a market with
    /// undisplaceable slots); the count frees when a maker position closes.
    function test_R5P1_makerSlotsAreCapped() public {
        PerpMarketHarness(address(market)).setGuardsUnchecked(40, 30 minutes, 100e6);
        pool.proposeMakerRegistrar(address(this));
        _warpAll(block.timestamp + pool.TIMELOCK());
        pool.setMakerRegistrar(address(this));
        uint256 cap = market.MAX_MAKER_POSITIONS();
        address[] memory makers = new address[](cap + 1);
        for (uint256 i; i <= cap; i++) {
            makers[i] = address(uint160(0x3a000 + i));
            pool.setMaker(makers[i], true);
            _fund(makers[i], 101e6);
            vm.prank(makers[i]);
            if (i < cap) market.open(i % 2 == 0, 100e6, 101e6, 100);
            else {
                vm.expectRevert(PerpMarket.TooManyMakerPositions.selector);
                market.open(true, 100e6, 101e6, 100);
            }
        }
        assertEq(market.makerPositions(), cap);
        vm.prank(makers[0]);
        market.close();
        assertEq(market.makerPositions(), cap - 1);
        vm.prank(makers[cap]);
        market.open(true, 100e6, 101e6, 100);
        assertEq(market.makerPositions(), cap);
        // A maker flag is fixed at open: deregistering later does not make a maker position displaceable.
        pool.setMaker(makers[1], false);
        assertTrue(market.position(makers[1]).maker);
    }

    /// Cost of making a CHOSEN (non-maker) victim the smallest mature position and displacing it: fill every free slot
    /// with young 100-USDG positions, then open twice the victim. On a 5,000 USDG retail victim that is about 1.2% of
    /// 2 x 5,000 plus 0.6 USDG per filler, and the victim still receives exactly its own close at the oracle price.
    function test_R5P1_targetingAChosenVictimCostAndOutcome() public {
        PerpMarketHarness(address(market)).setGuardsUnchecked(40, 30 minutes, 100e6);
        address victim = makeAddr("victim");
        _fund(victim, 1_000e6);
        vm.prank(victim);
        market.open(false, 5_000e6, 1_000e6, 100);
        _warpAll(block.timestamp + 31 minutes);
        uint256 free = market.MAX_OPEN_POSITIONS() - market.openPositionCount();
        uint256 spent = _fillYoung(free);
        (address smallest,) = market.smallestMaturePosition();
        assertEq(smallest, victim);
        uint256 expected = market.exitValueOf(victim);
        uint256 vb = usdg.balanceOf(victim);
        address whale = makeAddr("whale2");
        _fund(whale, 2_000e6);
        spent += 2_000e6;
        vm.prank(whale);
        market.open(true, 10_000e6, 2_000e6, 100);
        assertEq(usdg.balanceOf(victim) - vb, expected, "the victim gets its own close");
        uint256 back;
        vm.prank(whale);
        market.close();
        back += usdg.balanceOf(whale);
        for (uint256 i; i < free; i++) {
            address s = address(uint160(0x5e000 + i));
            vm.prank(s);
            market.close();
            back += usdg.balanceOf(s);
        }
        uint256 cost = spent - back;
        emit log_named_uint("free slots filled", free);
        emit log_named_uint("attacker cost to close a chosen 5,000 USDG victim (USDG units)", cost);
        assertGt(cost, 10_000e6 * 60 / 10_000, "at least the 2x open's round trip (60 bps)");
    }
}
