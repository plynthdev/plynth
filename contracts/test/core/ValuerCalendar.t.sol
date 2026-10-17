// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

contract RevertingFeed {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("down");
    }
}

/// Audit M-1 (market-closed hold, not just an age check) and the sequencer-uptime lead.
contract ValuerCalendarTest is Test {
    // Friday 2027-01-15 00:00 UTC (1_800_000_000 is Friday 08:00 UTC).
    uint256 constant FRI = 1_800_000_000 - 8 hours;

    StockTokenRegistry reg;
    Valuer valuer;
    MockFeed feed;
    MockStockToken tok;
    address board = makeAddr("board");

    function setUp() public {
        vm.warp(FRI);
        reg = new StockTokenRegistry(board);
        valuer = new Valuer(reg, 26 hours);
        feed = new MockFeed(8, 250e8, "mock");
        tok = new MockStockToken("Mock", "MOCK");
        vm.prank(board);
        reg.list(address(tok), address(feed), true);
    }

    function _holdAt(uint256 t) internal returns (bool) {
        vm.warp(t);
        feed.set(250e8); // a round this very second: only the calendar can hold it
        return valuer.quote(address(tok)).hold;
    }

    function test_weekendHoldsAFreshRoundOnlyWithTheCalendarOn() public {
        assertFalse(_holdAt(FRI + 1 days)); // Saturday, calendar off (default): the old behaviour
        valuer.enableMarketCalendar();
        assertTrue(_holdAt(FRI + 19 hours)); // on but no holiday table yet: every price holds (fails closed)
        valuer.setCalendarValidUntil(FRI + 365 days);
        assertFalse(_holdAt(FRI + 20 hours - 1)); // Friday 19:59:59 UTC
        assertTrue(_holdAt(FRI + 20 hours)); // Friday 20:00 UTC: closed
        assertTrue(_holdAt(FRI + 1 days + 12 hours)); // Saturday
        assertTrue(_holdAt(FRI + 2 days + 23 hours)); // Sunday 23:00 UTC
        assertTrue(_holdAt(FRI + 3 days + 1 hours - 1)); // Monday 00:59:59 UTC
        assertFalse(_holdAt(FRI + 3 days + 1 hours)); // Monday 01:00 UTC: open
        assertFalse(_holdAt(FRI + 4 days + 3 hours)); // Tuesday 03:00 UTC (overnight session)
    }

    function test_calendarIsOneWayAndOwnerOnly() public {
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, board));
        valuer.enableMarketCalendar();
        valuer.enableMarketCalendar();
        vm.expectRevert(Valuer.AlreadySet.selector);
        valuer.enableMarketCalendar();
    }

    function test_holidayClosesAtOnceAndReopensOnlyWithNotice() public {
        valuer.enableMarketCalendar();
        valuer.setCalendarValidUntil(FRI + 365 days);
        uint256 tue = (FRI + 4 days) / 1 days;
        uint256[] memory d = new uint256[](1);
        d[0] = tue;
        valuer.closeDays(d);
        assertTrue(_holdAt(tue * 1 days + 15 hours));
        assertFalse(_holdAt(tue * 1 days + 1 days + 15 hours));
        // Too close to reopen (the day already started / starts within 48 h).
        vm.expectRevert(abi.encodeWithSelector(Valuer.TooSoon.selector, tue));
        valuer.reopenDay(tue);
        uint256 later = tue + 10;
        d[0] = later;
        valuer.closeDays(d);
        valuer.reopenDay(later);
        assertFalse(valuer.closedDay(later));
    }

    function test_futureDatedRoundHolds() public {
        feed.set(250e8);
        feed.setUpdatedAt(block.timestamp + 1);
        assertTrue(valuer.quote(address(tok)).hold);
    }

    function test_sequencerDownOrJustRestartedHolds() public {
        vm.warp(FRI + 9 hours);
        MockFeed seq = new MockFeed(0, 0, "seq");
        // Review v2 L-5: queued first, applied after CHANGE_DELAY.
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq)));
        assertEq(address(valuer.sequencerFeed()), address(0));
        vm.warp(block.timestamp + 48 hours); // Sunday 09:00 UTC; quotes below run with the calendar off
        seq.setUpdatedAt(block.timestamp - 2 hours); // up for 2 h
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq)));
        assertEq(address(valuer.sequencerFeed()), address(seq));
        feed.set(250e8);
        assertFalse(valuer.quote(address(tok)).hold);
        seq.set(1); // down
        assertTrue(valuer.quote(address(tok)).hold);
        seq.set(0); // back up just now
        assertTrue(valuer.quote(address(tok)).hold);
        vm.warp(block.timestamp + 1 hours);
        feed.set(250e8);
        assertFalse(valuer.quote(address(tok)).hold);
    }

    /// A feed that cannot be read is refused when set (review v2 L-5); one that stops answering later holds.
    function test_unreadableSequencerFeedHolds() public {
        address bad = address(new RevertingFeed());
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadSequencerFeed.selector, bad));
        valuer.setSequencerFeed(AggregatorV3Interface(bad));
        MockFeed seq = new MockFeed(0, 0, "seq");
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq)));
        vm.warp(block.timestamp + 48 hours);
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq)));
        vm.etch(address(seq), bad.code);
        assertTrue(valuer.quote(address(tok)).hold);
    }
}
