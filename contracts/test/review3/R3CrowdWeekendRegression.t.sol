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
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Review v3 (2026-10-17) R3-ORC-1 PoC (wt-review3 R3CrowdWeekendMissed.t.sol), turned into a regression test that
/// asserts the safe behaviour. A crowd that completes over a weekend used to count as missed from Saturday 18:30 UTC,
/// so a stranger could execute it at the first fresh round on Monday, before the live keeper's secret beacon time.
/// Now a fallback time in a closed market is not the keeper's miss: the book stays the keeper's through the whole
/// first open window and opens to the public only at that window's end - GRACE, with the same tight band.
/// Mainnet values: 26 h staleness, calendar ON with the MainnetBeta NYSE table, windows 19:30 -> 19:30 UTC,
/// GRACE 1 h, slippage 100 bps, MIN_CROWD 3, SPY pool fee 500 (band 15 bps).
contract R3CrowdWeekendRegressionTest is Test {
    uint256 constant U = 1e6;
    uint256 constant PRICE = 660e18;
    uint64 constant GENESIS = 1795980600; // Sun 2026-11-29 19:30 UTC
    uint256 constant FRI_2059 = 1796417940; // Fri 2026-12-04 20:59 UTC (last weekday round; held from 20:00 anyway)
    uint256 constant SAT_1200 = 1796472000; // Sat 2026-12-05 12:00 UTC
    uint256 constant MON_0100 = 1796605200; // Mon 2026-12-07 01:00 UTC (winter: overnight session reopens)

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
    PoolKey key;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    uint256 nonce;

    function setUp() public {
        vm.warp(GENESIS - 2 days);
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, 26 hours);
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
        key = PoolKey(c0, c1, 500, 10, IHooks(address(0)));
        vm.prank(owner);
        router.setPool(address(tok), key);
        _poolPrice(PRICE);
        usdg.mint(address(pm), 1e15);
        tok.mint(address(pm), 1e27);
        beacon = new JitterBeacon(keeper, owner, 1 hours);
        vault = new SavingsVault(IERC20(address(usdg)), makeAddr("permit2"), ICanonicalRegistry(address(registry)), owner, keeper);
        crowd = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, 100, GENESIS, owner, keeper, 1 days);
        vm.prank(owner);
        vault.setCrowd(address(crowd));
    }

    /// Pool price in USD per token (1e18): what one USDG buys.
    function _poolPrice(uint256 p) internal {
        if (key.currency0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (p * 1e6));
        else pm.setRate(key, p * 1e6 / 1e18);
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

    function _weekendBook() internal returns (uint64 monStart, uint64 monEnd, bytes32 k, bytes32 secret, uint64 executeAt) {
        (monStart, monEnd) = crowd.windowOf(MON_0100);
        k = crowd.beaconKey(address(tok), monStart);
        for (uint256 i;; ++i) {
            secret = keccak256(abi.encode("keeper secret", i));
            executeAt = monStart + beacon.offsetOf(secret, k, monStart, monEnd);
            if (executeAt > MON_0100 + 2 hours) break;
        }
        vm.warp(FRI_2059);
        feed.set(int256(PRICE / 1e10));
        vm.prank(keeper);
        beacon.commit(k, monStart, monEnd, keccak256(abi.encode(secret, k)));
        vm.warp(SAT_1200);
        _join(makeAddr("a"), 400 * U);
        _join(makeAddr("b"), 400 * U);
        _join(makeAddr("c"), 400 * U);
    }

    /// The PoC's stranger, at the PoC's moment (Mon 01:10 UTC, first fresh round, pool pushed to the band edge on a
    /// lagging oracle): refused. The book counts as missed only from Monday 18:30 UTC, the end of the keeper's first
    /// open window minus GRACE; the live keeper runs it at its own secret time.
    function test_R3ORC1_weekendBookStaysTheKeepersOnTheFirstOpenDay() public {
        (, uint64 monEnd, bytes32 k, bytes32 secret, uint64 executeAt) = _weekendBook();
        uint64 from = crowd.missedFrom(address(tok), crowd.book(address(tok), 0).crowdSince);
        assertEq(from, monEnd - 1 hours, "missed only from Mon 18:30 UTC, not Sat 18:30");

        vm.warp(MON_0100);
        feed.set(int256(PRICE / 1e10));
        vm.warp(MON_0100 + 10 minutes);
        uint16 band = crowd.publicSlippageBps(address(tok));
        assertEq(band, 15, "the tight band is unchanged");
        _poolPrice(PRICE * 10_000 / (10_000 - (band - 5) + 1));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.execute(address(tok));

        // The keeper executes at its secret time, on a fresh round, at a pool back at the oracle.
        vm.warp(executeAt);
        feed.set(int256(PRICE / 1e10));
        _poolPrice(PRICE);
        beacon.reveal(k, secret);
        vm.prank(keeper);
        crowd.execute(address(tok));
        assertTrue(crowd.book(address(tok), 0).executed);
    }

    /// Keeper dead: the public path opens at Monday 18:30 UTC (one GRACE before the first open window ends), on a
    /// round at most 15 minutes old and inside the band; not a minute earlier.
    function test_R3ORC1_deadKeeperWeekendBookOpensAfterTheFirstOpenWindow() public {
        (, uint64 monEnd,,,) = _weekendBook();
        uint64 from = monEnd - 1 hours;
        vm.warp(from - 1 minutes);
        feed.set(int256(PRICE / 1e10));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.execute(address(tok));
        vm.warp(from + 1 minutes);
        feed.set(int256(PRICE / 1e10));
        vm.prank(makeAddr("stranger"));
        crowd.execute(address(tok));
        assertTrue(crowd.book(address(tok), 0).executed);
    }

    /// Thanksgiving week: a crowd that completes on the Wednesday evening (after 18:30) skips Thursday (closed),
    /// Friday (early close: closed at 18:30 UTC) and the weekend; it counts as missed only from Monday 18:30 UTC.
    function test_R3ORC1_holidayFallbacksAreSkipped() public {
        uint64 wed = 1795617000; // Wed 2026-11-25 14:30 UTC
        vm.warp(wed);
        feed.set(int256(PRICE / 1e10));
        _join(makeAddr("a"), 400 * U);
        _join(makeAddr("b"), 400 * U);
        vm.warp(wed + 5 hours); // 19:30: the next window (Wed 19:30 -> Thu 19:30)
        _join(makeAddr("c"), 400 * U);
        uint64 from = crowd.missedFrom(address(tok), crowd.book(address(tok), 0).crowdSince);
        assertEq(from, 1796063400, "Mon 2026-11-30 18:30 UTC");
    }
}
