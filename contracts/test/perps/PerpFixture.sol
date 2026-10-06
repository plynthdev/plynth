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

/// One pool, one market on a mock Stock Token priced per share (multiplier applied by the Valuer),
/// 1,000,000 USDG of LP liquidity. Defaults: fees, funding and borrow all off; tests turn on what they test.
abstract contract PerpFixture is Test {
    MockUSDG usdg;
    StockTokenRegistry registry;
    Valuer valuer;
    MockStockToken token;
    MockFeed feed;
    PerpPool pool;
    PerpMarket market;

    address owner = makeAddr("owner");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address operator = makeAddr("operator");

    uint256 constant LP_SEED = 1_000_000e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, 30 minutes);
        token = new MockStockToken("Mock Tesla", "mTSLA");
        feed = new MockFeed(8, 100e8, "mTSLA / USD");
        registry.list(address(token), address(feed), false);

        pool = new PerpPool(usdg, owner);
        market = new PerpMarket(pool, valuer, address(token), owner);
        vm.prank(owner);
        pool.addMarket(address(market));
        _params(0, 0, 1000, 0, 0, 2_000, 10_000, 5e6);

        _fund(lp, LP_SEED);
        vm.startPrank(lp);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(LP_SEED, lp);
        vm.stopPrank();

        address[3] memory traders = [alice, bob, operator];
        for (uint256 i; i < traders.length; i++) {
            vm.prank(traders[i]);
            usdg.approve(address(pool), type(uint256).max);
        }
    }

    function _params(
        uint256 taker,
        uint256 maker,
        uint256 spread,
        uint256 borrow,
        uint256 k,
        uint256 oiCap,
        uint256 maxProfit,
        uint256 liqFee
    ) internal {
        vm.prank(owner);
        market.setParams(taker, maker, spread, borrow, k, oiCap, maxProfit, liqFee);
    }

    function _fund(address to, uint256 amount) internal {
        usdg.mint(to, amount);
    }

    function _setPrice(int256 p8) internal {
        feed.set(p8);
    }

    /// Open for `who` with freshly minted collateral.
    function _open(address who, bool isLong, uint256 size, uint256 collateral) internal {
        _fund(who, collateral);
        vm.prank(who);
        market.open(isLong, size, collateral, 10_000);
    }

    function _close(address who) internal returns (uint256 got) {
        uint256 b = usdg.balanceOf(who);
        vm.prank(who);
        market.close();
        got = usdg.balanceOf(who) - b;
    }

    /// Re-post the same price (a fresh round), so a test that skipped time is not on hold.
    function _refresh() internal {
        feed.set(feed.latestAnswer());
    }

    function _hold() internal {
        feed.setUpdatedAt(block.timestamp - 31 minutes);
    }
}
