// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";

/// Values canonical Stock Tokens in USD (1e18) from Chainlink x ERC-8056 multiplier.
/// A price that cannot be trusted does not revert: it returns hold = true so callers allow only risk-reducing
/// actions. A quote is on hold when any of these holds:
///   - the feed is older than `maxStaleness` (outage, or a quiet feed);
///   - the market calendar is on and the US equity market is closed: the weekend, from Friday 20:00 UTC
///     (16:00 New York in summer, an hour early in winter) to Monday 01:00 UTC (Sunday 21:00 / 20:00 New York,
///     when the overnight session reopens), and every UTC day the owner marked closed (holidays). An age check
///     alone is not enough: Chainlink's equity feeds stop at the close and a 24 h heartbeat plus slack keeps
///     Friday's close "fresh" well into the weekend while the token keeps trading elsewhere (audit M-1);
///   - an L2 sequencer-uptime feed is set and reports the sequencer down, or up for less than SEQUENCER_GRACE.
///
/// Owner powers are risk-reducing or one-way: switch the calendar on (never off), mark a day closed (at once),
/// un-mark a day only while it is at least HOLIDAY_NOTICE away, and set the sequencer feed once.
contract Valuer is Ownable2Step {
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
    /// A day can be un-marked only while it starts at least this far in the future.
    uint256 public constant HOLIDAY_NOTICE = 48 hours;
    /// After the sequencer comes back, prices stay on hold this long (Chainlink's recommended pattern).
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    StockTokenRegistry public immutable registry;
    uint256 public immutable maxStaleness;

    bool public marketCalendar;
    AggregatorV3Interface public sequencerFeed;
    mapping(uint256 utcDay => bool) public closedDay;

    event MarketCalendarEnabled();
    event ClosedDaySet(uint256 indexed utcDay, bool closed);
    event SequencerFeedSet(address indexed feed);

    error NotCanonical(address token);
    error BadAnswer(address token, int256 answer);
    error AlreadySet();
    error ZeroAddress();
    error TooSoon(uint256 utcDay);

    constructor(StockTokenRegistry registry_, uint256 maxStaleness_) Ownable(msg.sender) {
        registry = registry_;
        maxStaleness = maxStaleness_;
    }

    // ---------------------------------------------------------------- owner (risk-reducing or one-way)

    /// Turns the weekend / holiday hold on. One-way.
    function enableMarketCalendar() external onlyOwner {
        if (marketCalendar) revert AlreadySet();
        marketCalendar = true;
        emit MarketCalendarEnabled();
    }

    /// Marks UTC days closed (a holiday): applies at once, it only holds prices.
    function closeDays(uint256[] calldata utcDays) external onlyOwner {
        for (uint256 i; i < utcDays.length; ++i) {
            closedDay[utcDays[i]] = true;
            emit ClosedDaySet(utcDays[i], true);
        }
    }

    /// Un-marks a closed day (a mistake): only for a day that starts at least HOLIDAY_NOTICE from now.
    function reopenDay(uint256 utcDay) external onlyOwner {
        if (utcDay * 1 days < block.timestamp + HOLIDAY_NOTICE) revert TooSoon(utcDay);
        closedDay[utcDay] = false;
        emit ClosedDaySet(utcDay, false);
    }

    /// The Chainlink L2 sequencer-uptime feed (answer 0 = up, 1 = down; startedAt = last status change). Set once.
    function setSequencerFeed(AggregatorV3Interface feed) external onlyOwner {
        if (address(sequencerFeed) != address(0)) revert AlreadySet();
        if (address(feed) == address(0)) revert ZeroAddress();
        sequencerFeed = feed;
        emit SequencerFeedSet(address(feed));
    }

    // ---------------------------------------------------------------- views

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

    /// USD value (1e18) of `rawUnits` of `token` held in base units.
    function value(address token, uint256 rawUnits) external view returns (uint256 usd, bool hold) {
        Quote memory q = quote(token);
        uint8 dec = IStockToken(token).decimals();
        usd = rawUnits * q.priceUsdPerToken / (10 ** dec);
        hold = q.hold;
    }

    /// True while the calendar is on and now is inside the weekly closed span or a closed UTC day.
    function marketClosed() public view returns (bool) {
        if (!marketCalendar) return false;
        return isClosedAt(block.timestamp);
    }

    /// The calendar rule at `t` (ignores the on/off switch).
    function isClosedAt(uint256 t) public view returns (bool) {
        if (closedDay[t / 1 days]) return true;
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
