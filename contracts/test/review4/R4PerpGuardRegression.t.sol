// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "../perps/PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Carried review v3 Info R3-PERP-3 (wt-review4 r3orig R3Perps.t.sol::test_exploit_R3P3_instantFloorRaiseBlocksPartialDecrease),
/// turned into a regression test: a minCollateral raise is no longer instant, so it cannot stop existing positions
/// trimming without 48 h of public notice.
contract R4PerpGuardRegressionTest is PerpFixture {
    function setUp() public override {
        super.setUp();
        _params(10, 6, 1000, 1, 2.78e11, 2_000, 10_000, 5e6);
        harness.setGuardsUnchecked(40, 30 minutes, 100e6);
    }

    function test_R3P3_floorRaiseWaitsTheTimelock() public {
        _open(alice, true, 5_000e6, 1_000e6);
        bytes32 id = market.guardsId(PerpMarket.Guards(40, 30 minutes, 1e6, 10_000e6));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.TimelockActive.selector, id, 0));
        market.setGuards(40, 30 minutes, 1e6, 10_000e6);
        skip(1 hours);
        _refresh();
        vm.prank(alice);
        market.decrease(1_000e6); // still trims under the current floor
        vm.prank(owner);
        market.proposeGuards(40, 30 minutes, 1e6, 10_000e6); // public notice; alice can act within 48 h
        assertGt(market.etaOf(id), block.timestamp);
    }
}
