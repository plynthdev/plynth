// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Audit M-1: the public fallback execute could be sandwiched on a stale price. With the mainnet staleness (26 h) a
/// round hours old still counted as fresh; after hours the pool moves while the feed holds the last close. An
/// attacker keeps the book under MIN_CROWD (so the keeper cannot run it), and at `windowEnd - GRACE`, in one
/// transaction, completes the crowd with a sybil, pushes the pool back to the stale price, executes and sells back.
/// The audit's book: 1,001 USDG (two savers of 500 plus a 1 USDG sybil), losing ~10%; a fresh-oracle control: bps.
contract CrowdBuyPublicPathTest is CrowdBuyBase {
    uint256 internal constant TRUE_PRICE = PRICE_A * 9_000 / 10_000; // the market moved 10% after the last round

    function _maxStaleness() internal pure override returns (uint256) {
        return 26 hours; // the mainnet value (MainnetBeta.DEFAULT_MAX_STALENESS)
    }

    /// The keeper committed (and never revealed) windows 0 and 2, so their fallback time is windowEnd - GRACE.
    function setUp() public override {
        super.setUp();
        _commit(address(tokA), 0, keccak256("s0"));
        _commit(address(tokA), 2, keccak256("s2"));
    }

    /// Window 2 runs Monday 08:00 UTC -> Tuesday 08:00 UTC: a weekday, so only the age rules are in play.
    function _publicFrom() internal pure returns (uint64) {
        return _windowStart(2) + 1 days - 1 hours;
    }

    /// USDG (6 dp) the book's tokens are worth at the true price.
    function _worth(uint256 raw, uint256 price) internal pure returns (uint256) {
        return raw * price / 1e18 / 1e12;
    }

    /// The attacker's single transaction: sybil completes the crowd, pool pushed to the stale price, execute.
    function _attack(address sybil) internal {
        _joinA(sybil, 1 * U);
        _setPool(address(tokA), PRICE_A); // push the pool back to the stale oracle price
        vm.prank(makeAddr("attacker"));
        crowd.execute(address(tokA));
    }

    function test_M1_sandwichOnStaleRoundWithSybilCrowdIsRefused() public {
        _joinA(_user(0), 500 * U);
        _joinA(_user(1), 500 * U);
        uint64 from = _publicFrom();
        vm.warp(from - 3 hours);
        feedA.set(int256(PRICE_A / 1e10)); // last round, 3 h before the fallback opens: "fresh" under 26 h
        vm.warp(from);
        _setPool(address(tokA), TRUE_PRICE); // arbitrageurs moved the pool to the real price

        address sybil = _user(9);
        // Before the fix this transaction filled the 1,001 USDG book at the stale price (~100 USDG lost).
        try this.attackExternal(sybil) {
            (, CrowdBuy.Book memory open) = crowd.openBook(address(tokA));
            CrowdBuy.Book memory b = crowd.book(address(tokA), 0);
            uint256 lost = b.usdgTotal - _worth(b.rawOut, TRUE_PRICE);
            emit log_named_uint("book lost (USDG 6dp)", lost);
            assertEq(open.accounts, 0);
            revert("public fallback executed a sybil-completed book on a stale round");
        } catch (bytes memory err) {
            // The crowd completed at the fallback time itself, so for this book the public path opens only at the
            // next window's fallback time (review v2 L-3: missedFrom).
            assertEq(bytes4(err), CrowdBuy.NotKeeper.selector);
        }
        assertFalse(crowd.book(address(tokA), 0).executed);
    }

    function attackExternal(address sybil) external {
        _attack(sybil);
    }

    /// Crowd formed in time (honest), but the only round predates the fallback: refused, also with a sybil-free book.
    function test_M1_publicPathNeedsARoundPublishedAfterItOpened() public {
        _joinA(_user(0), 500 * U);
        _joinA(_user(1), 500 * U);
        _joinA(_user(2), 1 * U);
        uint64 from = _publicFrom();
        vm.warp(from - 3 hours);
        feedA.set(int256(PRICE_A / 1e10));
        vm.warp(from + 1 minutes);
        _setPool(address(tokA), PRICE_A);
        // The crowd formed in window 0, so the book counts as missed from window 0's fallback time (review v2 L-3);
        // the round must still be newer than that and at most 15 minutes old.
        uint64 missed = crowd.missedFrom(address(tokA), crowd.book(address(tokA), 0).crowdSince);
        assertLt(missed, from);
        vm.warp(missed - 1);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.execute(address(tokA));
        vm.warp(from + 1 minutes);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.StalePrice.selector, uint256(from - 3 hours), missed));
        crowd.execute(address(tokA));

        // A round after the fallback opened but older than 15 minutes: still refused.
        feedA.set(int256(TRUE_PRICE / 1e10));
        uint256 roundAt = block.timestamp;
        vm.warp(roundAt + 15 minutes + 1);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.StalePrice.selector, roundAt, missed));
        crowd.execute(address(tokA));
    }

    /// Control: a fresh round at the true price, crowd formed before the fallback opened. The public path works
    /// (a dead keeper never blocks) and the book pays only the pool fee (5 bps here), not the stale gap.
    function test_M1_freshRoundControlExecutesAtTheTruePrice() public {
        _joinA(_user(0), 500 * U);
        _joinA(_user(1), 500 * U);
        _joinA(_user(2), 1 * U);
        uint64 from = _publicFrom();
        vm.warp(from + 5 minutes);
        feedA.set(int256(TRUE_PRICE / 1e10));
        _setPool(address(tokA), TRUE_PRICE);
        vm.prank(makeAddr("anyone"));
        crowd.execute(address(tokA));
        CrowdBuy.Book memory b = crowd.book(address(tokA), 0);
        assertTrue(b.executed);
        uint256 lost = b.usdgTotal - _worth(b.rawOut, TRUE_PRICE);
        assertLe(lost * 10_000, b.usdgTotal * 5 + 10_000); // the 0.05% pool fee (+ rounding)
    }

    /// A cancel that drops the crowd below MIN_CROWD resets the clock: re-completing it late does not count.
    function test_M1_crowdClockResetsWhenACancelDropsBelowMinimum() public {
        _joinA(_user(0), 500 * U);
        _joinA(_user(1), 500 * U);
        _joinA(_user(2), 1 * U);
        assertEq(crowd.book(address(tokA), 0).crowdSince, block.timestamp);
        vm.prank(_user(2));
        crowd.cancel(address(tokA), 0);
        assertEq(crowd.book(address(tokA), 0).crowdSince, 0);
        uint64 from = _publicFrom();
        vm.warp(from + 1 minutes);
        _joinA(_user(3), 1 * U);
        feedA.set(int256(PRICE_A / 1e10));
        // Re-completed after the fallback time: this book's public path opens a window later (missedFrom).
        assertEq(crowd.missedFrom(address(tokA), uint64(from + 1 minutes)), from + 1 days);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.execute(address(tokA));
        // The keeper is unaffected: it picks its own (secret) time inside the window.
        _executeAsKeeper(address(tokA));
    }

    /// Weekend: with the market calendar on, a feed updated a minute ago still holds (the market is closed), for the
    /// keeper and the public path alike.
    function test_M1_marketClosedHoldsEvenAFreshRound() public {
        valuer.enableMarketCalendar();
        valuer.setCalendarValidUntil(block.timestamp + 365 days);
        _joinA(_user(0), 500 * U);
        _joinA(_user(1), 500 * U);
        _joinA(_user(2), 1 * U);
        // Window 0 is Saturday 08:00 -> Sunday 08:00 UTC: its fallback (Sunday 07:00) is inside the weekend.
        uint64 from = _windowStart(0) + 1 days - 1 hours;
        vm.warp(from + 1 minutes);
        feedA.set(int256(PRICE_A / 1e10));
        assertTrue(valuer.marketClosed());
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.MarketOnHold.selector, address(tokA)));
        crowd.execute(address(tokA));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.MarketOnHold.selector, address(tokA)));
        _executeAsKeeper(address(tokA));
    }
}
