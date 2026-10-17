// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

/// Random traders, LPs, prices (incl. 50% gaps), time, funding, borrow, fees, holds and liquidations
/// across two markets sharing one pool.
contract PerpHandler is Test {
    MockUSDG immutable usdg;
    PerpPool immutable pool;
    PerpMarket[2] markets;
    MockFeed[2] feeds;
    address[4] actors;
    address[2] lps;

    uint256 public opens;
    uint256 public closes;
    uint256 public liquidations;

    constructor(MockUSDG usdg_, PerpPool pool_, PerpMarket[2] memory m, MockFeed[2] memory f) {
        (usdg, pool, markets, feeds) = (usdg_, pool_, m, f);
        for (uint256 i; i < 4; i++) {
            actors[i] = makeAddr(string.concat("trader", vm.toString(i)));
            vm.prank(actors[i]);
            usdg.approve(address(pool), type(uint256).max);
        }
        for (uint256 i; i < 2; i++) {
            lps[i] = makeAddr(string.concat("lp", vm.toString(i)));
            vm.prank(lps[i]);
            usdg.approve(address(pool), type(uint256).max);
        }
    }

    function open(uint256 a, uint256 m, bool isLong, uint256 size, uint256 lev) external {
        address who = actors[a % 4];
        PerpMarket mk = markets[m % 2];
        size = bound(size, 1e6, 300_000e6);
        lev = bound(lev, 1, 60);
        uint256 coll = size / lev + size / 1000 + 1;
        usdg.mint(who, coll);
        vm.prank(who);
        try mk.open(isLong, size, coll, 10_000) {
            opens++;
        } catch {}
    }

    function decrease(uint256 a, uint256 m, uint256 frac) external {
        address who = actors[a % 4];
        PerpMarket mk = markets[m % 2];
        uint256 size = mk.position(who).size;
        if (size == 0) return;
        vm.prank(who);
        try mk.decrease(size * bound(frac, 1, 100) / 100 + 1) {} catch {}
    }

    function close(uint256 a, uint256 m) external {
        address who = actors[a % 4];
        PerpMarket mk = markets[m % 2];
        if (mk.position(who).size == 0) return;
        vm.prank(who);
        mk.close(); // closing must never revert
        closes++;
    }

    function liquidate(uint256 a, uint256 m) external {
        PerpMarket mk = markets[m % 2];
        address who = actors[a % 4];
        if (!mk.isLiquidatable(who)) return;
        mk.liquidate(who);
        liquidations++;
    }

    function movePrice(uint256 m, uint256 bps, bool up) external {
        MockFeed f = feeds[m % 2];
        int256 p = f.latestAnswer();
        int256 d = p * int256(bound(bps, 0, 5_000)) / 10_000;
        int256 np = up ? p + d : p - d;
        if (np < 1e8) np = 1e8;
        f.set(np);
    }

    function warp(uint256 dt, bool refresh) external {
        skip(bound(dt, 1, 3 days));
        if (refresh) {
            for (uint256 i; i < 2; i++) {
                feeds[i].set(feeds[i].latestAnswer());
            }
        }
    }

    function deposit(uint256 i, uint256 amount) external {
        address who = lps[i % 2];
        amount = bound(amount, 1e6, 500_000e6);
        usdg.mint(who, amount);
        vm.prank(who);
        pool.deposit(amount, who);
    }

    function redeem(uint256 i, uint256 frac) external {
        address who = lps[i % 2];
        uint256 max = pool.maxRedeem(who);
        if (max == 0) return;
        vm.prank(who);
        pool.redeem(max * bound(frac, 1, 100) / 100, who, who);
    }

    /// Independent per-position LP valuation: each position's PnL clamped to [-collateral, max payout], or the
    /// reserve once the market has been on hold past its grace.
    function clampedPnl(uint256 m) external view returns (int256 sum) {
        PerpMarket mk = markets[m];
        if (mk.heldFor() > mk.HELD_GRACE()) return int256(mk.reserve());
        (uint256 pr,) = mk.price();
        for (uint256 i; i < 4; i++) {
            PerpMarket.Position memory p = mk.position(actors[i]);
            if (p.size == 0) continue;
            int256 value = int256(p.tokens * pr / mk.ONE());
            int256 v = p.isLong ? value - int256(p.size) : int256(p.size) - value;
            int256 cap = int256(p.size * mk.maxProfitBps() / 10_000);
            if (v > cap) v = cap;
            if (v < -int256(p.collateral)) v = -int256(p.collateral);
            sum += v;
        }
    }

    /// Independent sum of every open position's maximum payout above its collateral.
    function maxTraderProfit() external view returns (uint256 sum, uint256 coll) {
        for (uint256 m; m < 2; m++) {
            for (uint256 i; i < 4; i++) {
                PerpMarket.Position memory p = markets[m].position(actors[i]);
                sum += p.size * markets[m].maxProfitBps() / 10_000;
                coll += p.collateral;
            }
        }
    }
}

contract PerpInvariantTest is Test {
    PerpHandler handler;
    MockUSDG usdg;
    PerpPool pool;
    PerpMarket[2] markets;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        StockTokenRegistry registry = new StockTokenRegistry(address(this));
        Valuer valuer = new Valuer(registry, 30 minutes);
        pool = new PerpPool(usdg, address(this), 24 hours, 48 hours);
        MockFeed[2] memory feeds;
        for (uint256 i; i < 2; i++) {
            MockStockToken t = new MockStockToken("Mock", "mX");
            feeds[i] = new MockFeed(8, int256(100e8 * (i + 1)), "mock");
            registry.list(address(t), address(feeds[i]), false);
            markets[i] = new PerpMarket(pool, valuer, address(t), address(this));
            markets[i].setParams(10, 2, 1000, 2, 1e12, 3_000, 10_000, 5e6);
            pool.addMarket(address(markets[i]));
        }
        handler = new PerpHandler(usdg, pool, markets, feeds);
        usdg.transferOwnership(address(handler));
        for (uint256 i; i < 2; i++) {
            feeds[i].transferOwnership(address(handler));
        }
        // seed liquidity through the handler's LP path
        handler.deposit(0, 400_000e6);
        targetContract(address(handler));
    }

    /// Pool solvency: LP cash covers every trader's maximum (capped) profit at any price.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_poolCoversMaxTraderProfit() public view {
        (uint256 maxProfit,) = handler.maxTraderProfit();
        assertGe(pool.liquidAssets(), maxProfit);
        assertGe(pool.liquidAssets(), pool.totalReserved());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_bookkeepingMatches() public view {
        (uint256 maxProfit, uint256 coll) = handler.maxTraderProfit();
        uint256 reserved;
        uint256 sideColl;
        for (uint256 i; i < 2; i++) {
            reserved += markets[i].reserve();
            (,, uint256 lc) = markets[i].longs();
            (,, uint256 sc) = markets[i].shorts();
            sideColl += lc + sc;
        }
        assertEq(pool.totalReserved(), reserved);
        assertGe(reserved + 2, maxProfit); // per-position floors vs aggregate floor
        assertEq(pool.traderCollateral(), coll);
        assertEq(sideColl, coll);
        assertGe(usdg.balanceOf(address(pool)), pool.traderCollateral());
    }

    /// PERP-7: LP equity values each position on its own (no netting of one trader's bad debt against another's
    /// gain), so it never exceeds pool cash plus what traders can lose (their collateral).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_lpEquityFloorsEachPosition() public view {
        for (uint256 i; i < 2; i++) {
            assertApproxEqAbs(markets[i].traderPnl(), handler.clampedPnl(i), 8, "per-position clamp");
        }
        assertLe(pool.totalAssets(), pool.liquidAssets() + pool.traderCollateral());
    }

    /// The handler really trades: opens, liquidates and closes happen (guards against an all-revert run).
    function test_handlerReachesOpenLiquidateClose() public {
        handler.open(0, 0, true, 100_000e6, 40);
        handler.open(1, 0, false, 50_000e6, 2);
        handler.movePrice(0, 5_000, false);
        handler.liquidate(0, 0);
        handler.close(1, 0);
        assertEq(handler.opens(), 2);
        assertEq(handler.liquidations(), 1);
        assertEq(handler.closes(), 1);
        invariant_poolCoversMaxTraderProfit();
        invariant_bookkeepingMatches();
        invariant_lpEquityFloorsEachPosition();
    }
}
