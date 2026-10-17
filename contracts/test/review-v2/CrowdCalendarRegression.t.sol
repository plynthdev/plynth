// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon} from "../../src/consumer/CrowdBuy.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockPoolManager, MockStockERC20} from "../mocks/MockV4.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Review v2 (2026-10-16) crowd / oracle PoCs (rv2-crowd CrowdCalendarReview.t.sol), turned into regression tests
/// that assert the safe behaviour. They run with the v2 MainnetBeta values: 26 h staleness, the calendar on WITH the
/// NYSE holiday table and its validity, no sequencer feed (none exists on Robinhood Chain), windows 19:30 -> 19:30
/// UTC, GRACE 1 h, slippage 100 bps, MIN_CROWD 3.
contract CrowdCalendarRegressionTest is Test {
    uint256 constant U = 1e6;
    uint256 constant PRICE = 660e18;
    uint64 constant GENESIS = 1790537400; // Sun 2026-09-27 19:30 UTC (MainnetBeta: windows end 19:30 UTC)

    MockUSDG usdg;
    StockTokenRegistry registry;
    Valuer valuer;
    MockPoolManager pm;
    StockRouter router;
    JitterBeacon beacon;
    SavingsVault vault;
    CrowdBuy crowd;
    MockStockERC20 tok;
    MockFeed feed;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    uint256 nonce;

    function setUp() public {
        vm.warp(GENESIS - 2 days);
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, 26 hours); // MainnetBeta.DEFAULT_MAX_STALENESS
        // Exactly what MainnetBeta._core does now (review v2 M-1).
        MainnetBeta script = new MainnetBeta();
        valuer.enableMarketCalendar();
        valuer.closeDays(script.nyseClosedDays());
        valuer.earlyCloseDays(script.nyseEarlyCloses());
        valuer.setCalendarValidUntil(script.CALENDAR_VALID_UNTIL());
        tok = new MockStockERC20("SPY", 18);
        feed = new MockFeed(8, int256(PRICE / 1e10), "SPY");
        registry.list(address(tok), address(feed), true);
        pm = new MockPoolManager();
        router = new StockRouter(IPoolManager(address(pm)), registry, valuer, IERC20Metadata(address(usdg)), owner);
        (address c0, address c1) = address(usdg) < address(tok) ? (address(usdg), address(tok)) : (address(tok), address(usdg));
        PoolKey memory key = PoolKey(c0, c1, 500, 10, IHooks(address(0)));
        vm.prank(owner);
        router.setPool(address(tok), key);
        if (c0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (PRICE * 1e6));
        else pm.setRate(key, PRICE * 1e6 / 1e18);
        usdg.mint(address(pm), 1e15);
        tok.mint(address(pm), 1e27);
        beacon = new JitterBeacon(keeper, owner, 1 hours);
        vault = new SavingsVault(IERC20(address(usdg)), makeAddr("permit2"), ICanonicalRegistry(address(registry)), owner, keeper);
        crowd = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, 100, GENESIS, owner, keeper, 1 days);
        vm.prank(owner);
        vault.setCrowd(address(crowd));
    }

    function _join(address user, uint256 amount) internal {
        usdg.mint(user, amount);
        vm.startPrank(user);
        vault.setSettings(SavingsVault.Settings(10, 1, uint64(500 * U), 0, 0));
        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](1);
        m[0] = SavingsVault.MixEntry(address(tok), 10_000);
        vault.setMix(m);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        uint256 left = amount;
        while (left != 0) {
            uint256 chunk = left < 10 * U - 1 ? left : 10 * U - 1;
            vm.prank(keeper);
            vault.accrue(user, bytes32(++nonce), 0, 10 * U - chunk);
            left -= chunk;
        }
        vm.prank(user);
        crowd.join(user);
    }

    function tryExecute() external {
        crowd.execute(address(tok));
    }

    /// V2-L3 (KEEP-6): keeper dead from the start, replaying the REAL SPY/USD rounds on Robinhood Chain mainnet
    /// (Sep 30 -> Oct 16 2026). Before the fix the public fallback only ran inside the one 18:30-19:30 UTC slot of a
    /// window and this book waited until Fri Oct 16 (15 days). Now a book the keeper missed (its crowd formed before
    /// window 0's fallback time) runs at any later open-market time on a round at most 15 minutes old.
    function test_V2L3_deadKeeperBookRunsOnTheNextFreshRound() public {
        vm.warp(GENESIS - 1 days);
        _join(makeAddr("a"), 100 * U);
        _join(makeAddr("b"), 100 * U);
        _join(makeAddr("c"), 100 * U);
        uint64 missed = crowd.missedFrom(address(tok), crowd.book(address(tok), 0).crowdSince);
        assertEq(missed, GENESIS + 1 days - 1 hours, "Mon Sep 28 18:30 UTC: window 0's fallback");
        uint256[23] memory rounds = [
            uint256(1790797800), 1790863305, 1790875849, 1790944238, 1791158420, 1791222309, 1791294137, 1791380345,
            1791466771, 1791480395, 1791498761, 1791570259, 1791763224, 1791849628, 1791936053, 1791986288,
            1791994421, 1792071125, 1792076347, 1792122920, 1792163973, 1792170155, 1792176877
        ];
        // No round between the missed fallback (Mon 18:30) and Wed 19:50 in this replay: the book waits for one.
        uint256 ri;
        uint64 executedAt;
        uint256 attempts;
        for (uint64 t = missed; t < missed + 20 days && executedAt == 0; t += 5 minutes) {
            while (ri < rounds.length && rounds[ri] <= t) {
                vm.warp(rounds[ri]);
                feed.set(int256(PRICE / 1e10));
                ++ri;
            }
            vm.warp(t);
            ++attempts;
            vm.prank(makeAddr("anyone"));
            try this.tryExecute() {
                executedAt = t;
            } catch {}
        }
        console.log("public execute attempts", attempts);
        console.log("first public execution (unix)", executedAt);
        assertGe(executedAt, rounds[0], "only on a round published after missedFrom");
        assertLe(executedAt, rounds[0] + 15 minutes, "on the first fresh round (Wed Sep 30 19:50 UTC), not 15 days late");
    }

    /// V2-M1: Thanksgiving Thu 2026-11-26 (NYSE closed; last round Wed 21:00 UTC) is held all day, and so is every
    /// NYSE weekday holiday from Nov 2026 to Sep 2027 the PoC listed; early closes hold from 17:00 UTC.
    function test_V2M1_thanksgivingIsHeld() public {
        vm.warp(1795640400); // Wed 2026-11-25 21:00 UTC
        feed.set(int256(PRICE / 1e10));
        vm.warp(1795705200); // Thu 2026-11-26 15:00 UTC
        assertTrue(valuer.marketClosed(), "calendar says closed on Thanksgiving");
        assertTrue(valuer.quote(address(tok)).hold, "Wednesday's close is not tradable on the holiday");
        vm.warp(1795651200 + 23 hours - 1); // Thu 22:59:59 UTC
        assertTrue(valuer.quote(address(tok)).hold);
        uint256[10] memory hol = [uint256(20783), 20812, 20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067];
        for (uint256 i; i < hol.length; ++i) assertTrue(valuer.closedDay(hol[i]));
        // Fri 2026-11-27 (early close 13:00 New York): open in the morning, held from 17:00 UTC.
        uint256 fri = 20784 * 1 days;
        vm.warp(fri + 15 hours);
        feed.set(int256(PRICE / 1e10));
        assertFalse(valuer.quote(address(tok)).hold, "the early-close morning trades");
        vm.warp(fri + 17 hours);
        feed.set(int256(PRICE / 1e10));
        assertTrue(valuer.quote(address(tok)).hold, "held from 17:00 UTC");
    }

    /// V2-M1: a table nobody extends fails closed at calendarValidUntil (2029-10-01) instead of failing open.
    function test_V2M1_expiredCalendarHolds() public {
        uint256 until = valuer.calendarValidUntil();
        vm.warp(until - 2 days); // Sat 2029-09-29: weekend anyway; go to the Thursday before
        vm.warp(until - 4 days + 15 hours); // Thu 2029-09-27 15:00 UTC
        feed.set(int256(PRICE / 1e10));
        assertFalse(valuer.quote(address(tok)).hold);
        vm.warp(until + 15 hours); // Mon 2029-10-01 15:00 UTC: a normal trading day, but the table has run out
        feed.set(int256(PRICE / 1e10));
        assertTrue(valuer.marketClosed());
        assertTrue(valuer.quote(address(tok)).hold, "fails closed");
    }

    /// V2-L21: the owner cannot turn the holiday calendar into an indefinite hold: weekdays only, at most 16 per year,
    /// and the validity only moves forward, after 48 h, at most ~3 years ahead.
    function test_V2L21_closeDaysBounded() public {
        uint256[] memory d = new uint256[](1);
        uint256 sat = 20785; // 2026-11-28, a Saturday
        d[0] = sat;
        vm.expectRevert(abi.encodeWithSelector(Valuer.NotWeekday.selector, sat));
        valuer.closeDays(d);
        uint256 y = valuer.yearOf(20783);
        uint256 marked = valuer.markedInYear(y);
        uint256[] memory many = new uint256[](17 - marked);
        uint256 day = 20797; // Mon 2026-12-07
        for (uint256 i; i < many.length; ++i) {
            while ((day + 4) % 7 == 0 || (day + 4) % 7 == 6 || valuer.closedDay(day) || valuer.earlyCloseDay(day)) ++day;
            many[i] = day++;
        }
        vm.expectRevert(abi.encodeWithSelector(Valuer.TooManyClosedDays.selector, y));
        valuer.closeDays(many);
        uint256 until = valuer.calendarValidUntil();
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadValidUntil.selector, until));
        valuer.setCalendarValidUntil(until); // not forward
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadValidUntil.selector, block.timestamp + 1462 days));
        valuer.setCalendarValidUntil(block.timestamp + 1462 days); // too far ahead
        valuer.setCalendarValidUntil(until + 30 days); // queued only
        assertEq(valuer.calendarValidUntil(), until);
        vm.warp(block.timestamp + 48 hours);
        valuer.setCalendarValidUntil(until + 30 days);
        assertEq(valuer.calendarValidUntil(), until + 30 days);
    }

    /// V2-L5: a sequencer feed must look like one (code, answer 0/1, startedAt set), waits 48 h, and can be replaced.
    /// Robinhood Chain has no Chainlink uptime feed (accepted risk): the mainnet config leaves it unset.
    function test_V2L5_sequencerFeedValidatedDelayedReplaceable() public {
        assertEq(address(valuer.sequencerFeed()), address(0));
        address eoa = makeAddr("typo-eoa");
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadSequencerFeed.selector, eoa));
        valuer.setSequencerFeed(AggregatorV3Interface(eoa));
        MockFeed priceFeed = new MockFeed(8, 100e8, "not an uptime feed");
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadSequencerFeed.selector, address(priceFeed)));
        valuer.setSequencerFeed(AggregatorV3Interface(address(priceFeed)));
        MockFeed seq1 = new MockFeed(0, 0, "seq1");
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq1)));
        assertEq(address(valuer.sequencerFeed()), address(0), "queued, not applied");
        vm.warp(block.timestamp + 48 hours);
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq1)));
        assertEq(address(valuer.sequencerFeed()), address(seq1));
        MockFeed seq2 = new MockFeed(0, 0, "seq2");
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq2)));
        vm.warp(block.timestamp + 48 hours);
        valuer.setSequencerFeed(AggregatorV3Interface(address(seq2)));
        assertEq(address(valuer.sequencerFeed()), address(seq2), "replaceable");
    }

    /// V2-L4 (BAT-1): the public band is now the pool fee (5 bps here) + 10 bps, so the PoC's pool push to 0.44%
    /// above a fresh oracle no longer fills the book; a pool at the oracle still does.
    function test_V2L4_publicFallbackRefusesAPushedPool() public {
        vm.warp(GENESIS + 3 days + 12 hours); // Thu Oct 1 07:30 UTC
        _join(makeAddr("a"), 400 * U);
        _join(makeAddr("b"), 400 * U);
        _join(makeAddr("c"), 400 * U);
        uint64 from = GENESIS + 4 days - 1 hours; // Thu Oct 1 18:30 UTC
        vm.warp(from + 1 minutes);
        feed.set(int256(PRICE / 1e10));
        assertEq(crowd.publicSlippageBps(address(tok)), 15);
        (address c0, address c1) = address(usdg) < address(tok) ? (address(usdg), address(tok)) : (address(tok), address(usdg));
        PoolKey memory key = PoolKey(c0, c1, 500, 10, IHooks(address(0)));
        uint256 pushed = PRICE * 10_044 / 10_000;
        if (c0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (pushed * 1e6));
        else pm.setRate(key, pushed * 1e6 / 1e18);
        vm.prank(makeAddr("attacker"));
        vm.expectPartialRevert(StockRouter.Slippage.selector);
        crowd.execute(address(tok));
        if (c0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (PRICE * 1e6));
        else pm.setRate(key, PRICE * 1e6 / 1e18);
        vm.prank(makeAddr("anyone"));
        crowd.execute(address(tok));
        CrowdBuy.Book memory b = crowd.book(address(tok), 0);
        uint256 worth = b.rawOut * PRICE / 1e18 / 1e12;
        assertLe(b.usdgTotal - worth, b.usdgTotal * 15 / 10_000, "book within the public band of the oracle");
    }
}
