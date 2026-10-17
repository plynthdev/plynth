// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";

/// Values canonical Stock Tokens in USD (1e18) from Chainlink x ERC-8056 multiplier.
/// A price that cannot be trusted does not revert: it returns hold = true so callers allow only risk-reducing
/// actions. A quote is on hold when any of these holds:
///   - the feed is older than `maxStaleness` (outage, or a quiet feed);
///   - the market calendar is on and the US equity market is closed: the weekend, from Friday 20:00 UTC
///     (16:00 New York in summer, an hour early in winter) to Monday 01:00 UTC (Sunday 21:00 / 20:00 New York,
///     when the overnight session reopens), every UTC day the owner marked closed (NYSE full-day holidays), and
///     from EARLY_CLOSE (17:00 UTC) on a day marked as an early close (13:00 New York: 17:00 UTC in summer, 18:00
///     in winter, so the winter half-days hold an hour early, which only fails closed). An age check alone is not
///     enough: Chainlink's equity feeds stop at the close and a 24 h heartbeat plus slack keeps the last close
///     "fresh" well into a weekend or a holiday while the token keeps trading elsewhere (audit M-1, review v2 M-1);
///   - the calendar is on and `calendarValidUntil` has passed: a holiday table nobody kept up to date holds every
///     price (fails closed) instead of treating the next unlisted holiday as a trading day;
///   - an L2 sequencer-uptime feed is set and reports the sequencer down, or up for less than SEQUENCER_GRACE.
///
/// Owner powers are risk-reducing, bounded or delayed:
///   - switch the calendar on (never off);
///   - mark weekdays closed or early-closing at once (it only holds prices), at most MAX_CLOSED_PER_YEAR per UTC
///     year, so the calendar cannot become an indefinite hold (review v2 L-21); un-mark one only while it is at
///     least HOLIDAY_NOTICE away;
///   - set the first `calendarValidUntil` at once, then only move it forward, at most MAX_CALENDAR_HORIZON ahead,
///     after CHANGE_DELAY (48 h) in public (so somebody looks at the holidays again at least every four years);
///   - set or replace the sequencer feed after CHANGE_DELAY, only with a feed that answers like an uptime feed
///     (review v2 L-5). Robinhood Chain has no Chainlink uptime feed today, so mainnet runs without one.
contract Valuer is Ownable2Step, ChangeDelay {
    struct Quote {
        uint256 priceUsdPerToken; // 1e18, multiplier applied exactly once
        uint256 multiplier; // 1e18
        uint80 roundId;
        uint256 updatedAt;
        bool hold;
    }

    /// Weekly closed span, in seconds from Sunday 00:00 UTC: Friday 20:00 UTC to Monday 01:00 UTC (wraps).
    uint256 public constant WEEK_CLOSE = 5 days + 20 hours;
    uint256 public constant WEEK_OPEN = 1 days + 1 hours;
    /// An early-close day is closed from this time of day (UTC) on.
    uint256 public constant EARLY_CLOSE = 17 hours;
    /// A day can be un-marked only while it starts at least this far in the future.
    uint256 public constant HOLIDAY_NOTICE = 48 hours;
    /// After the sequencer comes back, prices stay on hold this long (Chainlink's recommended pattern).
    uint256 public constant SEQUENCER_GRACE = 1 hours;
    /// Closed plus early-close days per UTC year: NYSE has 9-10 full closures and up to 3 early closes, the rest is
    /// room for unscheduled closures (a national day of mourning, a weather closure).
    uint256 public constant MAX_CLOSED_PER_YEAR = 16;
    /// The furthest ahead `calendarValidUntil` may be set: four years of holidays.
    uint256 public constant MAX_CALENDAR_HORIZON = 1461 days;

    StockTokenRegistry public immutable registry;
    uint256 public immutable maxStaleness;

    bool public marketCalendar;
    /// Prices hold from this time on while the calendar is on (0 until it is first set: every price holds).
    uint256 public calendarValidUntil;
    AggregatorV3Interface public sequencerFeed;
    mapping(uint256 utcDay => bool) public closedDay;
    mapping(uint256 utcDay => bool) public earlyCloseDay;
    /// Days marked (closed or early close) per UTC year (years since 1970).
    mapping(uint256 utcYear => uint256) public markedInYear;

    event MarketCalendarEnabled();
    event ClosedDaySet(uint256 indexed utcDay, bool closed);
    event EarlyCloseSet(uint256 indexed utcDay, bool early);
    event CalendarValidUntilSet(uint256 validUntil);
    event SequencerFeedSet(address indexed feed);

    error NotCanonical(address token);
    error BadAnswer(address token, int256 answer);
    error AlreadySet();
    error ZeroAddress();
    error TooSoon(uint256 utcDay);
    error NotWeekday(uint256 utcDay);
    error TooManyClosedDays(uint256 utcYear);
    error BadValidUntil(uint256 validUntil);
    error BadSequencerFeed(address feed);

    constructor(StockTokenRegistry registry_, uint256 maxStaleness_) Ownable(msg.sender) {
        registry = registry_;
        maxStaleness = maxStaleness_;
    }

    // ---------------------------------------------------------------- owner (risk-reducing, bounded or delayed)

    /// Turns the weekend / holiday hold on. One-way. Until `calendarValidUntil` is set every price holds.
    function enableMarketCalendar() external onlyOwner {
        if (marketCalendar) revert AlreadySet();
        marketCalendar = true;
        emit MarketCalendarEnabled();
    }

    /// Marks weekdays (UTC day numbers) closed all day: a full-day holiday. Applies at once (it only holds prices).
    function closeDays(uint256[] calldata utcDays) external onlyOwner {
        for (uint256 i; i < utcDays.length; ++i) {
            uint256 d = utcDays[i];
            if (closedDay[d]) continue;
            _mark(d);
            closedDay[d] = true;
            emit ClosedDaySet(d, true);
        }
    }

    /// Marks weekdays as early closes: closed from EARLY_CLOSE (17:00 UTC) to the end of the UTC day.
    function earlyCloseDays(uint256[] calldata utcDays) external onlyOwner {
        for (uint256 i; i < utcDays.length; ++i) {
            uint256 d = utcDays[i];
            if (earlyCloseDay[d]) continue;
            _mark(d);
            earlyCloseDay[d] = true;
            emit EarlyCloseSet(d, true);
        }
    }

    /// Un-marks a closed or early-close day (a mistake): only for a day that starts at least HOLIDAY_NOTICE from now.
    function reopenDay(uint256 utcDay) external onlyOwner {
        if (utcDay * 1 days < block.timestamp + HOLIDAY_NOTICE) revert TooSoon(utcDay);
        if (closedDay[utcDay]) {
            closedDay[utcDay] = false;
            --markedInYear[yearOf(utcDay)];
            emit ClosedDaySet(utcDay, false);
        }
        if (earlyCloseDay[utcDay]) {
            earlyCloseDay[utcDay] = false;
            --markedInYear[yearOf(utcDay)];
            emit EarlyCloseSet(utcDay, false);
        }
    }

    /// The end of the period the holiday table covers. The first value applies at once (the deploy sets it with
    /// the table); later ones only move it forward and wait CHANGE_DELAY in public. At most MAX_CALENDAR_HORIZON
    /// ahead, so somebody has to look at the holidays again at least every four years.
    function setCalendarValidUntil(uint256 validUntil) external onlyOwner {
        if (validUntil <= block.timestamp || validUntil <= calendarValidUntil) revert BadValidUntil(validUntil);
        if (validUntil > block.timestamp + MAX_CALENDAR_HORIZON) revert BadValidUntil(validUntil);
        if (calendarValidUntil != 0 && !_delayed()) return;
        calendarValidUntil = validUntil;
        emit CalendarValidUntilSet(validUntil);
    }

    /// The Chainlink L2 sequencer-uptime feed (answer 0 = up, 1 = down; startedAt = last status change). Setting or
    /// replacing it waits CHANGE_DELAY; the feed must have code and answer like an uptime feed, so a typo cannot
    /// put every price on hold, and a bad feed can be replaced. It can never be removed.
    function setSequencerFeed(AggregatorV3Interface feed) external onlyOwner {
        if (address(feed) == address(0)) revert ZeroAddress();
        if (!_isUptimeFeed(feed)) revert BadSequencerFeed(address(feed));
        if (!_delayed()) return;
        sequencerFeed = feed;
        emit SequencerFeedSet(address(feed));
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    /// A new owner starts with no queued changes (ChangeDelay nonce, review v2 L-6).
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        _bumpChangeNonce();
    }

    function _mark(uint256 d) private {
        uint256 w = (d + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
        if (w == 0 || w == 6) revert NotWeekday(d);
        uint256 y = yearOf(d);
        uint256 n = markedInYear[y] + 1;
        if (n > MAX_CLOSED_PER_YEAR) revert TooManyClosedDays(y);
        markedInYear[y] = n;
    }

    function _isUptimeFeed(AggregatorV3Interface feed) private view returns (bool) {
        if (address(feed).code.length == 0) return false;
        try feed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return (answer == 0 || answer == 1) && startedAt != 0 && startedAt <= block.timestamp;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- views

    /// UTC calendar year of a UTC day number, as years since 1970 (exact from 1970 to 2099).
    function yearOf(uint256 utcDay) public pure returns (uint256) {
        return (utcDay * 4 + 2) / 1461;
    }

    function quote(address token) public view returns (Quote memory q) {
        StockTokenRegistry.Entry memory e = registry.entry(token);
        if (!e.active) revert NotCanonical(token);

        AggregatorV3Interface feed = AggregatorV3Interface(e.feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadAnswer(token, answer);

        uint256 price = _to1e18(uint256(answer), feed.decimals());
        q.multiplier = IStockToken(token).uiMultiplier();
        q.priceUsdPerToken = e.multiplierEmbedded ? price : price * q.multiplier / 1e18;
        q.roundId = roundId;
        q.updatedAt = updatedAt;
        q.hold = updatedAt + maxStaleness < block.timestamp || updatedAt > block.timestamp || marketClosed()
            || sequencerHold();
    }

    /// The token's registry feed read as `quote` reads it (multiplier applied once), whether or not the token is still
    /// listed, with the round id: a delisted perp market's last-resort settlement price (PerpMarket settleHeld, which
    /// applies its own staleness, band and confirmation checks). Reverts without a usable answer.
    function feedQuote(address token) external view returns (uint256 price, uint256 updatedAt, uint80 roundId) {
        StockTokenRegistry.Entry memory e = registry.entry(token);
        if (e.feed == address(0)) revert NotCanonical(token);
        AggregatorV3Interface feed = AggregatorV3Interface(e.feed);
        int256 answer;
        (roundId, answer,, updatedAt,) = feed.latestRoundData();
        uint8 dec = feed.decimals();
        if (answer <= 0 || dec > 18) revert BadAnswer(token, answer);
        price = _to1e18(uint256(answer), dec);
        if (!e.multiplierEmbedded) price = price * IStockToken(token).uiMultiplier() / 1e18;
    }

    /// USD value (1e18) of `rawUnits` of `token` held in base units.
    function value(address token, uint256 rawUnits) external view returns (uint256 usd, bool hold) {
        Quote memory q = quote(token);
        uint8 dec = IStockToken(token).decimals();
        usd = rawUnits * q.priceUsdPerToken / (10 ** dec);
        hold = q.hold;
    }

    /// True while the calendar is on and now is inside the weekly closed span, a closed day or the closed part of an
    /// early-close day, or the holiday table has run out (`calendarValidUntil` passed: fail closed).
    function marketClosed() public view returns (bool) {
        if (!marketCalendar) return false;
        if (block.timestamp >= calendarValidUntil) return true;
        return isClosedAt(block.timestamp);
    }

    /// The calendar rule at `t` (ignores the on/off switch and the table's validity).
    function isClosedAt(uint256 t) public view returns (bool) {
        uint256 d = t / 1 days;
        if (closedDay[d]) return true;
        if (earlyCloseDay[d] && t % 1 days >= EARLY_CLOSE) return true;
        uint256 w = (t + 4 days) % 7 days; // seconds since Sunday 00:00 UTC (1970-01-01 was a Thursday)
        return w >= WEEK_CLOSE || w < WEEK_OPEN;
    }

    /// True when a sequencer feed is set and the sequencer is down, recently restarted, or unreadable.
    function sequencerHold() public view returns (bool) {
        AggregatorV3Interface f = sequencerFeed;
        if (address(f) == address(0)) return false;
        try f.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer != 0 || startedAt == 0 || block.timestamp < startedAt + SEQUENCER_GRACE;
        } catch {
            return true;
        }
    }

    function _to1e18(uint256 x, uint8 dec) private pure returns (uint256) {
        if (dec == 18) return x;
        if (dec < 18) return x * 10 ** (18 - dec);
        return x / 10 ** (dec - 18);
    }
}
