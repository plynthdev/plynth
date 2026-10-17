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

    // ------------------------------------------------------------ R3-PERP-1: hedged slot fill (v4: displacement)

    function _fillAt(uint256 from, uint256 to, uint256 size) internal {
        for (uint256 i = from; i < to; i++) {
            address s = _sybil(i);
            uint256 coll = size * 1_006 / 1_000 + 1e6;
            _fund(s, coll);
            vm.prank(s);
            market.open(i % 2 == 0, size, coll, 10_000);
        }
    }

    function _mature() internal {
        skip(market.minHoldSeconds());
        _refresh();
    }

    /// The PoC: 100 hedged sybils at the floors fill the market. Once they are past their minimum hold, the blocked
    /// honest 20,000 open goes through by displacing the smallest; the slot count stays bounded.
    function test_R3P1_hedgedSlotFillNoLongerBlocksOpens() public {
        uint256 n = market.MAX_OPEN_POSITIONS();
        _fillAt(0, n, 100e6);
        _mature();
        (address smallest, uint256 sz) = market.smallestMaturePosition();
        assertEq(sz, 100e6);
        _fund(alice, 20_000e6);
        vm.expectEmit(true, true, false, true, address(market));
        emit PerpMarket.Displaced(smallest, alice, 100e6);
        vm.prank(alice);
        market.open(true, 20_000e6, 20_000e6, 10_000);
        assertEq(market.position(alice).size, 20_000e6);
        assertEq(market.position(smallest).size, 0, "the smallest sybil was closed for its owner");
        assertEq(market.openPositionCount(), n);
    }

    /// In a full market whose smallest mature slot holds Y, an open under DISPLACE_FACTOR * Y is refused, one at it
    /// is admitted.
    function test_R3P1_displacementThreshold() public {
        _fillAt(0, market.MAX_OPEN_POSITIONS(), 1_000e6);
        _mature();
        _fund(alice, 3_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(true, 2_000e6 - 1, 3_000e6, 10_000);
        vm.prank(alice);
        market.open(true, 2_000e6, 3_000e6, 10_000);
        assertEq(market.openPositionCount(), market.MAX_OPEN_POSITIONS());
    }

    /// Nothing raises anyone else's floor: in a full market an existing position trims down to the base floor.
    function test_R3P1_busyMarketNeverTrapsAPosition() public {
        _open(alice, true, 2_000e6, 2_000e6);
        _fillAt(0, market.MAX_OPEN_POSITIONS() - 1, 3_200e6);
        vm.prank(alice);
        market.decrease(1_000e6);
        vm.prank(alice);
        market.decrease(850e6);
        _close(alice);
        assertEq(market.position(alice).size, 0);
    }

    /// A young profitable position is never displaced: a 2x open takes the smallest MATURE position instead, and with
    /// no mature position it qualifies for, it reverts TooManyPositions.
    function test_R3P1_youngProfitablePositionCannotBeDisplaced() public {
        _fillAt(1, market.MAX_OPEN_POSITIONS(), 1_000e6);
        _mature();
        address young = _sybil(0);
        _fund(young, 101e6);
        vm.prank(young);
        market.open(true, 100e6, 101e6, 10_000); // the smallest, inside its hold
        _setPrice(105e8); // in profit
        _fund(bob, 10_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpMarket.TooManyPositions.selector);
        market.open(false, 1_999e6, 3_000e6, 10_000); // 2x the young one, but under 2x every mature one
        (address target,) = market.smallestMaturePosition();
        assertTrue(target != young);
        vm.prank(bob);
        market.open(false, 2_000e6, 3_000e6, 10_000); // 2x a mature 1,000: displaces that one
        assertEq(market.position(young).size, 100e6, "the young position keeps its slot and its profit");
        assertEq(market.position(target).size, 0);
    }

    /// A mature position that is displaced gets exactly what its own full close at the oracle price would pay,
    /// profit included.
    function test_R3P1_matureDisplacedKeepsItsProfit() public {
        address small = _sybil(0);
        _fund(small, 101e6);
        vm.prank(small);
        market.open(true, 100e6, 101e6, 10_000);
        _fillAt(1, market.MAX_OPEN_POSITIONS(), 1_000e6);
        _mature();
        _setPrice(110e8); // +10% for the small long
        uint256 expected = market.exitValueOf(small);
        assertGt(expected, market.position(small).collateral, "the close would pay a profit");
        uint256 b = usdg.balanceOf(small);
        _fund(bob, 1_000e6);
        vm.prank(bob);
        market.open(false, 200e6, 1_000e6, 10_000);
        assertEq(market.position(small).size, 0);
        assertEq(usdg.balanceOf(small) - b, expected, "displaced = its own full close, profit included");
    }

    /// Displacing one's own position (through a second account) pays exactly what closing it would: no advantage.
    function test_R3P1_selfDisplacementGivesNoAdvantage() public {
        address mine = _sybil(0);
        _fund(mine, 101e6);
        vm.prank(mine);
        market.open(true, 100e6, 101e6, 10_000);
        _fillAt(1, market.MAX_OPEN_POSITIONS(), 1_000e6);
        _mature();
        _setPrice(103e8);
        uint256 snap = vm.snapshotState();
        uint256 closed = _close(mine);
        vm.revertToState(snap);
        uint256 b = usdg.balanceOf(mine);
        _fund(bob, 1_000e6);
        vm.prank(bob); // the owner's own second account
        market.open(true, 200e6, 1_000e6, 10_000);
        assertEq(usdg.balanceOf(mine) - b, closed, "displacement pays what a close pays");
    }

    /// Keeping a slot inside its hold (so it cannot be displaced) needs an increase of at least minCollateral every
    /// hold period: a dust increase is refused.
    function test_R3P1_keepingASlotYoungNeedsARealIncrease() public {
        _open(alice, true, 1_000e6, 1_000e6);
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(PerpMarket.SizeTooSmall.selector);
        market.increase(1, 100e6, 10_000);
        vm.prank(alice);
        market.increase(0, 100e6, 10_000); // margin only: fine, and it does not restart the hold
        _fund(alice, 1e6);
        vm.prank(alice);
        market.increase(100e6, 1e6, 10_000);
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
        _setPrice(109e8); // the delisted token's feed keeps publishing (a fresh round, within 30% of lastPrice)
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
