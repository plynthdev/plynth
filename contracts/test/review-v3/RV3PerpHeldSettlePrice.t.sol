// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {RV3PerpMainnet} from "./RV3PerpMainnet.sol";

/// Review v3, V2-L1 (strengthens review-v2/PerpDustRegression::test_V2L1_delistOnQuietMarketDoesNotSettleAtOnce,
/// which never checked the settle price). Real PerpMarket / PerpPool / Valuer / StockTokenRegistry at the MainnetBeta
/// values (26 h staleness, market calendar on).
///
/// Scenario (the V2-L1 PoC): alice is short 100 tokens at 100 (10,000 size, 1,000 collateral) and nobody trades the
/// market for 6 days while the real price climbs 5% (feed rounds at the 50 bps deviation threshold or the 24 h
/// heartbeat, only while the market is open). Then the token is delisted, and after the 5-day grace anyone may
/// `settleHeld` at the market's stored `lastPrice`.
///   (a) with the keeper's perp-poke job (app/src/keeper/jobs/perp-poke.ts, `pokeDecision`, modelled hour by hour)
///       lastPrice is the last round before the delisting: alice settles at ~105 and pays her loss;
///   (b) with no poke for the 6 days, settleHeld settles at the 6-day-old 100: alice's 500 USDG loss is erased.
///       That is the known residual R3-PERP-6 (Low): it needs the keeper down for days AND a delisting inside that
///       window; the contract does not fix it (proposed fix: settle at the trader-worse of lastPrice and the last feed
///       answer). The test pins the stale price exactly so a fix shows up here.
contract RV3PerpHeldSettlePriceTest is RV3PerpMainnet {
    uint256 internal constant SIZE = 10_000e6;
    uint256 internal constant COLL = 1_000e6;
    uint256 internal constant QUIET = 6 days;
    uint256 internal constant POKE_AGE = 3600; // DEFAULT_PERP_POKE_AGE_S

    address internal alice;
    uint256 internal openedAt;

    function setUp() public override {
        super.setUp();
        alice = _trader("alice");
        feed.set(P0); // the round alice trades on
        openedAt = block.timestamp;
        _open(alice, false, SIZE, COLL);
        assertEq(market.lastPrice(), 100e18);
        assertEq(market.lastPriceAt(), openedAt);
    }

    /// The real price `t` seconds into the quiet period: +5% linearly over 6 days.
    function _truePrice(uint256 t) internal pure returns (int256) {
        return P0 + P0 * 500 * int256(t) / int256(QUIET) / 10_000;
    }

    /// Chainlink-like publisher: while the market is open, a round when the price is >= 50 bps off the last answer or
    /// the last round is 24 h old. Nothing over the weekend.
    function _publish(int256 truth) internal {
        if (valuer.marketClosed()) return;
        (, int256 last,, uint256 at,) = feed.latestRoundData();
        int256 dev = (truth - last) * 10_000 / last;
        if (dev < 0) dev = -dev;
        if (dev >= 50 || block.timestamp >= at + 24 hours) feed.set(truth);
    }

    /// perp-poke.ts pokeDecision, against the real contracts.
    function _keeperPoke() internal returns (bool poked) {
        if (market.openPositionCount() == 0) return false;
        if (block.timestamp <= market.lastPriceAt() + POKE_AGE) return false;
        try valuer.quote(address(token)) returns (Valuer.Quote memory q) {
            if (q.updatedAt <= market.lastPriceAt()) return false; // the feed has nothing newer (market closed)
        } catch {
            if (market.unpricedSince() != 0) return false; // already recorded since when
        }
        market.poke();
        return true;
    }

    /// Six days hour by hour: the feed publishes, and the keeper pokes when `withKeeper`. Then the delisting.
    function _quietWeekThenDelist(bool withKeeper) internal returns (uint256 delistAt, uint256 pokes) {
        for (uint256 h = 1; h <= QUIET / 1 hours; h++) {
            vm.warp(openedAt + h * 1 hours);
            _publish(_truePrice(h * 1 hours));
            if (withKeeper && _keeperPoke()) pokes++;
        }
        delistAt = block.timestamp;
        registry.delist(address(token));
    }

    function _settle() internal returns (Closed memory c, uint256 got) {
        uint256 b = usdg.balanceOf(alice);
        vm.recordLogs();
        vm.prank(makeAddr("anyone"));
        market.settleHeld(alice);
        c = _decreased(vm.getRecordedLogs());
        got = usdg.balanceOf(alice) - b;
        assertEq(got, c.payout);
        assertEq(market.openInterest(), 0);
    }

    /// What alice is paid at settle price `pr` (1e18): kept collateral + short PnL - borrow - close fee. Fees from
    /// the same parameters the market uses; borrow taken from the event and checked separately.
    function _expectedPayout(uint256 pr, uint256 borrow) internal pure returns (int256) {
        uint256 kept = COLL - SIZE * (40 + 10) / 10_000; // open spread + taker fee
        uint256 tokens = SIZE * 1e30 / 100e18; // ONE = 1e12 * 1e18
        int256 pnl = int256(SIZE) - int256((tokens * pr + 1e30 - 1) / 1e30);
        return int256(kept) + pnl - int256(borrow) - int256(SIZE * 10 / 10_000);
    }

    function _checkBorrow(uint256 borrow) internal view {
        // 1 bps per hour on 10,000 USDG of size = 1 USDG per hour, for every second since the open.
        uint256 expected = SIZE * (block.timestamp - openedAt) / (3600 * 10_000);
        assertApproxEqAbs(borrow, expected, 2, "borrow: 1 bps/h on size since the open");
    }

    /// (a) With the hourly keeper poke, the settle price is the last round before the delisting, not the 6-day-old one.
    function test_V2L1_withKeeperPokeHeldSettleUsesTheRecentPrice() public {
        (uint256 delistAt, uint256 pokes) = _quietWeekThenDelist(true);
        (, int256 lastAnswer,, uint256 lastRoundAt,) = feed.latestRoundData();
        emit log_named_uint("keeper pokes over 6 days", pokes);
        emit log_named_int("last feed answer before the delisting (8 dp)", lastAnswer);
        assertGt(pokes, 5);
        assertEq(market.lastPrice(), uint256(lastAnswer) * 1e10, "the keeper recorded the newest round");
        assertEq(market.lastPriceAt(), lastRoundAt);
        assertGe(lastRoundAt + 1 hours, delistAt - 24 hours, "a round of the last trading day");
        int256 truthAtDelist = _truePrice(QUIET);
        assertApproxEqRel(lastAnswer, truthAtDelist, 0.005e18, "within the 50 bps deviation of the real price");
        assertGe(lastAnswer, 104e8);

        // The keeper keeps running after the delisting: one poke records when the Valuer started reverting.
        vm.warp(delistAt + 1 hours);
        _keeperPoke();
        assertEq(market.unpricedSince(), delistAt);
        assertEq(market.heldFor(), 1 hours, "the hold counts from the delisting");

        vm.warp(delistAt + market.HELD_GRACE());
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, market.HELD_GRACE()));
        market.settleHeld(alice);
        vm.warp(delistAt + market.HELD_GRACE() + 1);
        (Closed memory c, uint256 got) = _settle();

        assertEq(c.price, uint256(lastAnswer) * 1e10, "settled at the last poked price");
        assertEq(c.funding, 0);
        _checkBorrow(c.borrow);
        assertEq(c.fee, SIZE * 10 / 10_000);
        int256 exp = _expectedPayout(c.price, c.borrow);
        assertGt(exp, 0);
        assertEq(got, uint256(exp), "payout = value at the poked price");
        // Against the stale settle of (b): alice pays her ~5% loss here.
        int256 atStale = _expectedPayout(100e18, c.borrow);
        assertGe(atStale - int256(got), 400e6, "at least 400 USDG of the ~500 loss is paid, not erased");
        emit log_named_uint("alice paid out, keeper poking (USDG units)", got);
    }

    /// (b) R3-PERP-6, fixed by the perps lane (00922fd): with no poke for 6 days, settleHeld on the delisted token
    /// after the grace settles at its feed's newer round (~104.55), not at the 6-day-old lastPrice (100), so alice
    /// pays her loss at the last published price.
    function test_V2L1_R3PERP6_withoutPokeHeldSettleUsesTheFeedsNewerRound() public {
        (uint256 delistAt,) = _quietWeekThenDelist(false);
        (, int256 lastAnswer,,,) = feed.latestRoundData();
        assertGe(lastAnswer, 104e8, "the feed moved +4-5% while nobody poked");
        assertEq(market.lastPrice(), 100e18, "still the price of the open");
        assertEq(market.lastPriceAt(), openedAt, "6 days old");

        // V2-L1 itself holds: not settleable at once, the grace counts from the delisting.
        assertEq(market.heldFor(), 0);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.NotHeldLongEnough.selector, 0));
        market.settleHeld(alice);
        vm.warp(delistAt + market.HELD_GRACE() + 1);
        (Closed memory c, uint256 got) = _settle();

        // The settle price is the feed's last round, not the stale stored price.
        assertEq(c.price, uint256(lastAnswer) * 1e10, "R3-PERP-6 fixed: settled at the feed's newer round");
        _checkBorrow(c.borrow);
        assertEq(got, uint256(_expectedPayout(c.price, c.borrow)));
        int256 atStale = _expectedPayout(100e18, c.borrow);
        assertEq(uint256(atStale) - got, SIZE * uint256(lastAnswer - P0) / uint256(P0), "alice pays size x the move since the open");
        emit log_named_uint("alice paid out, no poke (USDG units)", got);
    }
}
