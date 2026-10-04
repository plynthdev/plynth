// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestnetKit} from "../../script/TestnetKit.s.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {TestnetPoolSeeder} from "../../src/testnet/TestnetPoolSeeder.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";

/// Runs the testnet kit against the real Uniswap v4 PoolManager on an anvil-style fork of Robinhood Chain
/// testnet (46630). Skips when RHC_TESTNET_RPC_URL is unset. Nothing is broadcast.
contract TestnetKitTest is Test {
    TestnetKit kit;
    MockUSDG usdg;
    StockTokenRegistry registry;
    Valuer valuer;
    StockRouter router;
    JitterBeacon beacon;
    TestnetPoolSeeder seeder;
    TestnetKit.Stock[3] stocks;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");

    function setUp() public {
        string memory rpc = vm.envOr("RHC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        kit = new TestnetKit();
        TestnetKit.Deployment memory m = kit.deployAs(deployer);
        (usdg, registry, valuer, router, beacon, seeder) = (m.usdg, m.registry, m.valuer, m.router, m.beacon, m.seeder);
        for (uint256 i; i < 3; i++) {
            stocks[i] = m.stocks[i];
        }
    }

    function _aapl() internal view returns (TestnetKit.Stock memory) {
        return stocks[1];
    }

    function test_kit_deploysEverythingOwnedByDeployer() public view {
        assertEq(block.chainid, 46630);
        assertEq(usdg.owner(), deployer);
        assertEq(registry.owner(), deployer);
        assertEq(router.owner(), deployer);
        assertEq(beacon.owner(), deployer);
        assertEq(beacon.keeper(), deployer);
        assertEq(valuer.maxStaleness(), 30 minutes);
        assertEq(address(router.poolManager()), kit.POOL_MANAGER());
        assertEq(registry.tokens().length, 3);
    }

    function test_kit_stocksHaveSpecifiedMultipliersAndFeeds() public view {
        uint256[3] memory mult = [uint256(1e18), 1.0005e18, 1.0017e18];
        int256[3] memory price = [int256(250e8), 230e8, 570e8];
        string[3] memory sym = ["mTSLA", "mAAPL", "mSPY"];
        for (uint256 i; i < 3; i++) {
            TestnetKit.Stock memory s = stocks[i];
            assertEq(s.token.symbol(), sym[i]);
            assertEq(s.token.uiMultiplier(), mult[i]);
            assertEq(s.feed.decimals(), 8);
            assertEq(s.feed.latestAnswer(), price[i]);
            assertTrue(registry.isCanonical(address(s.token)));
        }
    }

    function test_kit_poolsUseSpecifiedKeyAndMatchRouter() public view {
        for (uint256 i; i < 3; i++) {
            TestnetKit.Stock memory s = stocks[i];
            assertEq(s.key.fee, 3000);
            assertEq(s.key.tickSpacing, 60);
            assertEq(address(s.key.hooks), address(0));
            assertLt(uint160(s.key.currency0), uint160(s.key.currency1));
            assertEq(s.poolId, keccak256(abi.encode(s.key)));
            PoolKey memory k = router.poolOf(address(s.token));
            assertEq(keccak256(abi.encode(k)), s.poolId);
        }
    }

    function test_kit_poolsHoldAbout100kUsdgOfLiquidityAndSeederKeepsNothing() public view {
        address pm = kit.POOL_MANAGER();
        // The PoolManager holds the USDG side of all three pools (50k each, full range).
        assertApproxEqRel(usdg.balanceOf(pm), 150_000e6, 0.01e18);
        for (uint256 i; i < 3; i++) {
            TestnetKit.Stock memory s = stocks[i];
            Valuer.Quote memory q = valuer.quote(address(s.token));
            uint256 tokenUsd6 = s.token.balanceOf(pm) * q.priceUsdPerToken / 1e30;
            assertApproxEqRel(tokenUsd6, 50_000e6, 0.01e18); // + 50k USDG side = ~100k per pool
            assertEq(s.token.balanceOf(address(seeder)), 0);
        }
        assertEq(usdg.balanceOf(address(seeder)), 0);
    }

    function test_kit_buyMaaplThroughRouterAtOraclePrice() public {
        TestnetKit.Stock memory s = _aapl();
        vm.prank(deployer);
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        IERC20(address(usdg)).approve(address(router), 100e6);
        (uint256 minOut,) = router.quoteMinOut(address(s.token), 100e6, true, 100);
        uint256 got = router.buy(address(s.token), 100e6, 100, alice);
        vm.stopPrank();
        assertGe(got, minOut);
        assertEq(s.token.balanceOf(alice), got);
        // $100 at $230 x 1.0005 per token is ~0.4346 mAAPL; 0.3% fee + tiny impact.
        uint256 oracleRaw = uint256(100e18) * 1e18 / (230e18 * 1.0005e18 / 1e18);
        assertApproxEqRel(got, oracleRaw, 0.006e18);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(s.token.balanceOf(address(router)), 0);
    }

    function test_kit_oracleGuardHoldsOnStaleFeed() public {
        TestnetKit.Stock memory s = _aapl();
        vm.prank(deployer);
        usdg.mint(alice, 100e6);
        vm.prank(deployer);
        s.feed.setUpdatedAt(block.timestamp - 31 minutes);
        vm.startPrank(alice);
        IERC20(address(usdg)).approve(address(router), 100e6);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.MarketOnHold.selector, address(s.token)));
        router.buy(address(s.token), 100e6, 100, alice);
        vm.stopPrank();
    }

    function test_kit_oracleGuardRejectsPoolFarFromOracle() public {
        TestnetKit.Stock memory s = _aapl();
        vm.prank(deployer);
        usdg.mint(alice, 100e6);
        // Oracle now says the share is 10% cheaper; the pool still sells at the old price -> too few tokens.
        vm.prank(deployer);
        s.feed.set(207e8);
        vm.startPrank(alice);
        IERC20(address(usdg)).approve(address(router), 100e6);
        vm.expectPartialRevert(StockRouter.Slippage.selector);
        router.buy(address(s.token), 100e6, 100, alice);
        vm.stopPrank();
    }

    function test_kit_frozenBuyerCannotBuy() public {
        TestnetKit.Stock memory s = _aapl();
        vm.startPrank(deployer);
        usdg.mint(alice, 100e6);
        usdg.freeze(alice);
        vm.stopPrank();
        vm.startPrank(alice);
        IERC20(address(usdg)).approve(address(router), 100e6);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, alice));
        router.buy(address(s.token), 100e6, 100, alice);
        vm.stopPrank();
    }

    function test_kit_rejectsOtherChains() public {
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(TestnetKit.UnsupportedChain.selector, uint256(31337)));
        kit.deployAs(deployer);
    }
}
