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

/// Many accounts open (any size from the floor up), trim and close on one real market (production guards), often
/// filling all MAX_OPEN_POSITIONS slots. The handler records every open that should have been admitted (a free slot,
/// or a full market and a size of at least DISPLACE_FACTOR x the smallest) but reverted.
contract PerpSlotHandler is Test {
    MockUSDG immutable usdg;
    PerpMarket immutable market;
    MockFeed immutable feed;
    uint256 internal constant N = 160;

    uint256 public refusedButShouldPass;
    /// Displaced positions that did not receive exactly what their voluntary full close would have paid.
    uint256 public displacedUnderpaid;
    uint256 public displacingOpens;
    uint256 public fullOpens;

    constructor(MockUSDG usdg_, PerpPool pool_, PerpMarket m, MockFeed f) {
        (usdg, market, feed) = (usdg_, m, f);
        for (uint256 i; i < N; i++) {
            vm.prank(_actor(i));
            usdg.approve(address(pool_), type(uint256).max);
        }
    }

    function _actor(uint256 i) internal pure returns (address) {
        return address(uint160(0x5107_0000 + (i % N)));
    }

    /// Three consecutive accounts try to open (so markets fill within a run's depth).
    function open(uint256 i, uint256 size, bool isLong) external {
        for (uint256 k; k < 3; k++) {
            _tryOpen(i + k, uint256(keccak256(abi.encode(size, k))), isLong != (k == 1));
        }
    }

    function _tryOpen(uint256 i, uint256 size, bool isLong) internal {
        address who = _actor(i);
        if (market.position(who).size != 0) return;
        (, bool hold) = market.price();
        if (hold) return; // a stale price refuses every open; not what this suite measures
        size = bound(size, 100e6, 20_000e6);
        uint256 coll = size * 1_006 / 1_000; // 1x plus fee + spread: never a collateral or leverage refusal
        usdg.mint(who, coll);
        bool full = market.openPositionCount() >= market.MAX_OPEN_POSITIONS();
        (address target, uint256 smallest) = market.smallestMaturePosition();
        bool shouldPass = !full || (target != address(0) && size >= smallest * market.DISPLACE_FACTOR());
        uint256 expected;
        uint256 before;
        if (full && shouldPass) {
            expected = market.exitValueOf(target); // what the target's own full close would pay now
            before = usdg.balanceOf(target);
        }
        vm.prank(who);
        try market.open(isLong, size, coll, 10_000) {
            if (full) {
                ++displacingOpens;
                if (market.position(target).size != 0 || usdg.balanceOf(target) - before != expected) ++displacedUnderpaid;
            }
        } catch {
            if (shouldPass) ++refusedButShouldPass;
        }
        if (full) ++fullOpens;
    }

    function trim(uint256 i, uint256 frac) external {
        address who = _actor(i);
        uint256 s = market.position(who).size;
        if (s == 0) return;
        uint256 cut = s * bound(frac, 1, 99) / 100;
        vm.prank(who);
        try market.decrease(cut) {} catch {}
    }

    function close(uint256 i) external {
        address who = _actor(i);
        if (i % 4 != 0 || market.position(who).size == 0) return; // rarer than opens, so markets fill up
        vm.prank(who);
        market.close();
    }

    function tick(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 20 minutes));
        feed.set(feed.latestAnswer()); // keep the price fresh (price moves are PerpInvariant's job)
    }
}

/// Review v4 R4-PERP-1, stated as an invariant: the open-position count never exceeds MAX_OPEN_POSITIONS, every
/// position keeps the base floors, and in a full market an open of DISPLACE_FACTOR times the smallest position is
/// always admitted (it displaces that position). So nobody can keep an open of size X out without holding X / 2 in
/// every slot.
contract PerpSlotInvariantTest is Test {
    MockUSDG usdg;
    PerpPool pool;
    PerpMarket market;
    MockFeed feed;
    PerpSlotHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        StockTokenRegistry registry = new StockTokenRegistry(address(this));
        Valuer valuer = new Valuer(registry, 1 hours);
        MockStockToken t = new MockStockToken("T", "T");
        feed = new MockFeed(8, 100e8, "T");
        registry.list(address(t), address(feed), false);
        pool = new PerpPool(usdg, address(this), 24 hours, 48 hours);
        market = new PerpMarket(pool, valuer, address(t), address(this)); // production guards: 40 bps, 30 min, 100
        pool.addMarket(address(market));
        pool.openDeposits();
        usdg.mint(address(this), 50_000_000e6); // deep enough that the 20% OI cap never binds here
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(50_000_000e6, address(this));
        handler = new PerpSlotHandler(usdg, pool, market, feed);
        feed.transferOwnership(address(handler));
        usdg.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 300
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_slotsBounded() public view {
        assertLe(market.openPositionCount(), market.MAX_OPEN_POSITIONS());
        address[] memory list = market.openPositions();
        for (uint256 i; i < list.length; i++) {
            PerpMarket.Position memory p = market.position(list[i]);
            assertGe(p.size, market.minCollateral());
            assertGe(p.collateral, market.minCollateral());
        }
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 300
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_fullMarketAdmitsADisplacingOpen() public view {
        assertEq(handler.refusedButShouldPass(), 0, "an open that should displace (or fill a free slot) was refused");
        (address a, uint256 s) = market.smallestMaturePosition();
        if (a != address(0)) {
            PerpMarket.Position memory p = market.position(a);
            assertEq(p.size, s);
            assertGe(block.timestamp, uint256(p.openedAt) + market.minHoldSeconds(), "only a mature position is displaceable");
        }
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 300
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_displacedGetsItsVoluntaryClose() public view {
        assertEq(handler.displacedUnderpaid(), 0, "a displaced position got other than its own full close");
    }


    function afterInvariant() external {
        emit log_named_uint("opens tried on a full market", handler.fullOpens());
        emit log_named_uint("displacing opens", handler.displacingOpens());
    }

    /// The suite does reach full markets and displacing opens (not vacuous).
    function test_handlerFillsAndDisplaces() public {
        for (uint256 i; i < 40; i++) handler.open(i * 3, 100e6 + i * 1e6, i % 2 == 0);
        handler.tick(20 minutes);
        handler.tick(20 minutes); // every position past its 30 min hold
        for (uint256 i = 40; i < 60; i++) handler.open(i * 3, 100e6 + i * 1e6, i % 2 == 0);
        assertEq(market.openPositionCount(), market.MAX_OPEN_POSITIONS());
        assertGt(handler.displacingOpens(), 0);
        assertEq(handler.refusedButShouldPass(), 0);
        assertEq(handler.displacedUnderpaid(), 0);
    }
}
