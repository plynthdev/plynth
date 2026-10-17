// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {TestnetKit} from "../../script/TestnetKit.s.sol";
import {TestnetPerpKit} from "../../script/TestnetPerpKit.s.sol";

/// The perps part of the testnet kit: a pool with 200k mock USDG and markets for mTSLA, mAAPL, mSPY.
contract PerpKitTest is Test {
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");

    function test_perpKit_deploysPoolAndThreeMarketsSeeded200k() public {
        vm.startPrank(deployer);
        MockUSDG usdg = new MockUSDG();
        StockTokenRegistry registry = new StockTokenRegistry(deployer);
        Valuer valuer = new Valuer(registry, 30 minutes);
        address[3] memory tokens;
        int256[3] memory prices = [int256(250e8), 230e8, 570e8];
        for (uint256 i; i < 3; i++) {
            MockStockToken t = new MockStockToken("Mock", "mX");
            registry.list(address(t), address(new MockFeed(8, prices[i], "mock")), false);
            tokens[i] = address(t);
        }
        vm.stopPrank();

        TestnetPerpKit kit = new TestnetPerpKit();
        TestnetPerpKit.Deployment memory d = kit.deployAs(deployer, usdg, valuer, tokens);
        _check(d, usdg, tokens);
    }

    /// Same, on top of the real testnet kit on a testnet fork (skips without RHC_TESTNET_RPC_URL).
    function test_perpKit_onTestnetKitFork() public {
        string memory rpc = vm.envOr("RHC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        TestnetKit.Deployment memory k = new TestnetKit().deployAs(deployer);
        address[3] memory tokens = [address(k.stocks[0].token), address(k.stocks[1].token), address(k.stocks[2].token)];
        TestnetPerpKit.Deployment memory d = new TestnetPerpKit().deployAs(deployer, k.usdg, k.valuer, tokens);
        _check(d, k.usdg, tokens);
    }

    function _check(TestnetPerpKit.Deployment memory d, MockUSDG usdg, address[3] memory tokens) internal {
        assertEq(d.pool.owner(), deployer);
        assertEq(d.pool.totalAssets(), 200_000e6);
        assertEq(d.pool.balanceOf(deployer) > 0, true);
        assertEq(d.pool.markets().length, 3);
        for (uint256 i; i < 3; i++) {
            assertEq(d.markets[i].underlying(), tokens[i]);
            assertEq(d.markets[i].owner(), deployer);
            assertTrue(d.pool.isMarket(address(d.markets[i])));
        }
        // a short on mAAPL opens and closes against the seeded pool
        PerpMarket m = d.markets[1];
        vm.prank(deployer);
        usdg.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdg.approve(address(d.pool), type(uint256).max);
        m.open(false, 5_000e6, 1_000e6, 100);
        m.close();
        vm.stopPrank();
        // 10 bps taker in and out, plus the open spread (charged on size at the open)
        uint256 spreadCost = 5_000e6 * m.openSpreadBps() / 10_000;
        assertApproxEqAbs(usdg.balanceOf(alice), 1_000e6 - 10e6 - spreadCost, 2);
    }
}
