// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "../perps/PerpFixture.sol";

/// Review v4 (2026-10-17) R4-PERP-2 PoC (wt-review4 R4HeldSettleDelistedFeed.t.sol), turned into regression tests that
/// assert the safe behaviour: settleHeld uses a delisted token's own feed only if the round is sane (positive, sane
/// decimals, not stale relative to the delisting, within 30% of the last recorded price).
contract R4HeldSettleRegressionTest is PerpFixture {
    function setUp() public override {
        super.setUp();
        _params(10, 6, 1000, 0, 0, 2_000, 10_000, 5e6);
        vm.prank(bob);
        usdg.approve(address(pool), type(uint256).max);
    }

    /// The PoC: the feed breaks (1 instead of ~100), OWNER delists at once. After the grace the bad round is refused
    /// and the short settles at the last good price, not at a +99% "profit" the LPs would pay.
    function test_R4P2_badRoundAfterDelistIsRefused() public {
        _open(bob, false, 10_000e6, 1_000e6);
        _setPrice(1e8);
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        _setPrice(1e8);
        uint256 b = usdg.balanceOf(bob);
        market.settleHeld(bob);
        uint256 got = usdg.balanceOf(bob) - b;
        emit log_named_uint("bob gets for a 1,000 USDG short (USDG units)", got);
        assertLt(got, 1_000e6, "settled at the last good price (100): collateral minus fees");
        assertGt(got, 900e6);
    }

    /// A sane newer round (fresh, within 30%) is still used: the R3-PERP-6 fix holds.
    function test_R4P2_saneNewerRoundIsUsed() public {
        _open(bob, false, 10_000e6, 1_000e6);
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        _setPrice(120e8); // +20%: a real move, inside the band
        uint256 b = usdg.balanceOf(bob);
        market.settleHeld(bob);
        assertLt(usdg.balanceOf(bob) - b, 1e6, "the short pays the +20% move (collateral gone)");
    }

    /// A round older than the Valuer's staleness before the delisting is not a price either.
    function test_R4P2_staleRoundIsRefused() public {
        _open(bob, false, 10_000e6, 1_000e6);
        skip(2 days); // nobody pokes; the feed's last round is 2 days old (the fixture's staleness is 30 min)
        _setPrice(110e8);
        feed.setUpdatedAt(block.timestamp - 2 days + 1 hours); // a round stamped long before the delisting
        registry.delist(address(token));
        skip(market.HELD_GRACE() + 1);
        uint256 b = usdg.balanceOf(bob);
        market.settleHeld(bob);
        assertGt(usdg.balanceOf(bob) - b, 900e6, "the stale round is ignored: lastPrice (100)");
    }
}
