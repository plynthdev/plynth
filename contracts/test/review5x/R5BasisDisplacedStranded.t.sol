// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasisSleeveTest} from "../treasury/sleeves/BasisSleeve.t.sol";
import {BasisSleeve} from "../../src/treasury/sleeves/BasisSleeve.sol";
import {PerpMarketHarness} from "../perps/PerpMarketHarness.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {IPerpVenue} from "../../src/interfaces/IPerpVenue.sol";

/// review5 R5-PERP-1 regression. A stranger displaced a treasury basis short (98 young 100-USDG positions fill the
/// market, then one 2x open) and the payout landed as idle USDG in the InHousePerpVenue, which BasisSleeve could never
/// move: ~$49k frozen for ~$1.3k. The same when OWNER retires a market and the keeper settles it. `sweepVenueIdle`
/// (anyone; pays only the account) now returns it, with guard NAV unchanged. Real BasisSleeve, InHousePerpVenue and
/// PerpPool; the market is the harness with the production guards put back.
contract R5BasisDisplacedStrandedTest is BasisSleeveTest {
    function _fund(address a, uint256 amt) internal {
        usdg.mint(a, amt);
        vm.prank(a);
        usdg.approve(address(pool), type(uint256).max);
    }

    function _sweepAndCheck(uint256 stranded) internal {
        uint256 navBefore = guard.snapshot(address(account)).nav;
        uint256 acct0 = usdg.balanceOf(address(account));
        vm.prank(makeAddr("anyone"));
        uint256 swept = basis.sweepVenueIdle(IPerpVenue(address(venue)));
        assertEq(swept, stranded, "the whole idle balance");
        assertEq(usdg.balanceOf(address(venue)), 0, "nothing left idle");
        assertEq(usdg.balanceOf(address(account)) - acct0, stranded, "back in the account");
        assertEq(guard.snapshot(address(account)).nav, navBefore, "guard NAV unchanged: idle venue cash -> account cash");
        assertEq(basis.sweepVenueIdle(IPerpVenue(address(venue))), 0, "a second sweep is a no-op");
    }

    function test_r5_displacedShortProceedsReturnToTheAccount() public {
        PerpMarketHarness(address(market)).setGuardsUnchecked(40, 30 minutes, 100e6); // MainnetBeta guards
        vm.prank(crowd2);
        market.open(true, 150_000e6, 30_000e6, 100);
        _openPair(address(aapl), 100_000e6, 50_000e6);
        _warpAll(block.timestamp + 31 minutes);
        for (uint256 i; i < 98; i++) {
            address a = address(uint160(0x5e000 + i));
            _fund(a, 101e6);
            vm.prank(a);
            market.open(i % 2 == 0, 100e6, 101e6, 100);
        }
        address whale = makeAddr("whale");
        _fund(whale, 40_000e6);
        vm.prank(whale);
        market.open(true, 200_000e6, 40_000e6, 100); // displaces the treasury short
        assertEq(market.position(address(venue)).size, 0);
        uint256 stranded = usdg.balanceOf(address(venue));
        assertGt(stranded, 49_000e6);
        _sweepAndCheck(stranded);
        _closePair(0); // the empty pair is cleared; nothing more to take
        assertEq(basis.pairedRaw(address(aapl)), 0);
    }

    function test_r5_retiredSettledShortProceedsReturnToTheAccount() public {
        _openPair(address(aapl), 100_000e6, 50_000e6);
        market.retire(); // this test owns the harness market
        _warpAll(market.retireAt() + 1);
        market.settleRetired(address(venue)); // the keeper's call
        uint256 stranded = usdg.balanceOf(address(venue));
        assertGt(stranded, 49_000e6);
        _sweepAndCheck(stranded);
    }

    function test_r5_sweepOnlyForOwnVenues() public {
        vm.expectRevert(BasisSleeve.BadVenue.selector);
        basis.sweepVenueIdle(IPerpVenue(makeAddr("notAVenue")));
    }

    /// The general property: whatever lands idle in a venue (any amount, any number of times), one sweep returns
    /// it all to the account and guard NAV never moves.
    function testFuzz_idleVenueCashAlwaysReturns(uint64 a, uint64 b) public {
        usdg.mint(address(venue), uint256(a));
        usdg.mint(address(venue), uint256(b));
        uint256 idle = usdg.balanceOf(address(venue));
        if (idle == 0) return;
        _sweepAndCheck(idle);
    }
}
