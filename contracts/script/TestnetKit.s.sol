// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../src/core/StockTokenRegistry.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {StockRouter} from "../src/core/StockRouter.sol";
import {JitterBeacon} from "../src/core/JitterBeacon.sol";
import {IHooks, IPoolManager, PoolKey} from "../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../src/testnet/MockStockToken.sol";
import {MockFeed} from "../src/testnet/MockFeed.sol";
import {TestnetPoolSeeder} from "../src/testnet/TestnetPoolSeeder.sol";
import {TestnetPoolMath} from "../src/testnet/TestnetPoolMath.sol";

/// Testnet kit: mock USDG, three mock Stock Tokens with feeds, the core contracts, and one real
/// Uniswap v4 pool per stock on the chain's PoolManager, seeded with ~100k mock USDG of liquidity.
/// Writes deployments/<chainid>.json. Run against anvil (or an anvil fork of testnet) only from agents;
/// the testnet broadcast is done by a human with their own keystore.
contract TestnetKit is Script {
    /// Uniswap v4 PoolManager, same address on 4663 and 46630.
    /// Source of truth: app/src/chain/index.ts (`uniV4PoolManager`), verified on both chains.
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant MAX_STALENESS = 30 minutes;
    uint256 public constant USDG_PER_POOL_SIDE = 50_000e6; // + equal value in stock = ~100k USDG per pool
    uint256 public constant HEADROOM_BPS = 100; // fund 1% extra; the seeder returns what the pool did not take

    struct Stock {
        string symbol;
        MockStockToken token;
        MockFeed feed;
        bytes32 poolId;
        PoolKey key;
    }

    struct Deployment {
        address deployer;
        MockUSDG usdg;
        StockTokenRegistry registry;
        Valuer valuer;
        StockRouter router;
        JitterBeacon beacon;
        TestnetPoolSeeder seeder;
        Stock[3] stocks;
    }

    error UnsupportedChain(uint256 chainId);

    /// Broadcast entry point: `forge script ... --broadcast` with a key or keystore.
    function run() external returns (Deployment memory d) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = _deploy(deployer);
        vm.stopBroadcast();
        _write(d);
    }

    /// Same deployment without broadcasting or writing files, for tests on a fork.
    function deployAs(address deployer) external returns (Deployment memory d) {
        vm.startPrank(deployer);
        d = _deploy(deployer);
        vm.stopPrank();
    }

    function _deploy(address deployer) internal returns (Deployment memory d) {
        if (block.chainid != 46630 && block.chainid != 4663) revert UnsupportedChain(block.chainid);
        IPoolManager pm = IPoolManager(POOL_MANAGER);

        d.deployer = deployer;
        d.usdg = new MockUSDG();
        d.registry = new StockTokenRegistry(deployer);
        d.valuer = new Valuer(d.registry, MAX_STALENESS);
        d.router = new StockRouter(pm, d.registry, d.valuer, IERC20Metadata(address(d.usdg)), deployer);
        d.beacon = new JitterBeacon(deployer, deployer);
        d.seeder = new TestnetPoolSeeder(pm);

        // Feeds price one SHARE (8 dp, like Chainlink); the token price is share price x uiMultiplier,
        // so the registry lists them with multiplierEmbedded = false and the Valuer applies it once.
        d.stocks[0] = _stock(d, "Mock Tesla", "mTSLA", 1e18, 250e8);
        d.stocks[1] = _stock(d, "Mock Apple", "mAAPL", 1.0005e18, 230e8);
        d.stocks[2] = _stock(d, "Mock SPDR S&P 500", "mSPY", 1.0017e18, 570e8);
    }

    function _stock(Deployment memory d, string memory name, string memory sym, uint256 mult, int256 price)
        internal
        returns (Stock memory s)
    {
        s.symbol = sym;
        s.token = new MockStockToken(name, sym);
        if (mult != 1e18) s.token.setUiMultiplier(mult);
        s.feed = new MockFeed(8, price, string.concat(sym, " / USD (mock, per share)"));
        d.registry.list(address(s.token), address(s.feed), false);

        bool usdgIs0 = address(d.usdg) < address(s.token);
        s.key = usdgIs0
            ? PoolKey(address(d.usdg), address(s.token), FEE, TICK_SPACING, IHooks(address(0)))
            : PoolKey(address(s.token), address(d.usdg), FEE, TICK_SPACING, IHooks(address(0)));

        // Pool price = Valuer price (feed x multiplier), so the oracle guard and the pool agree at start.
        uint256 p = d.valuer.quote(address(s.token)).priceUsdPerToken;
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(p, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, USDG_PER_POOL_SIDE, usdgIs0);
        uint256 tokenNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);

        d.usdg.mint(address(d.seeder), USDG_PER_POOL_SIDE * (10_000 + HEADROOM_BPS) / 10_000);
        s.token.mint(address(d.seeder), tokenNeed * (10_000 + HEADROOM_BPS) / 10_000);
        (s.poolId,) = d.seeder.seed(s.key, sqrtP, liq);
        d.router.setPool(address(s.token), s.key);
    }

    function _write(Deployment memory d) internal {
        string memory dir = string.concat(vm.projectRoot(), "/../app/deployments");
        string memory stocks = "stocks";
        for (uint256 i; i < 3; i++) {
            Stock memory s = d.stocks[i];
            string memory o = s.symbol;
            vm.serializeAddress(o, "token", address(s.token));
            vm.serializeAddress(o, "feed", address(s.feed));
            vm.serializeUint(o, "uiMultiplier", s.token.uiMultiplier());
            vm.serializeUint(o, "fee", s.key.fee);
            vm.serializeInt(o, "tickSpacing", s.key.tickSpacing);
            vm.serializeAddress(o, "currency0", s.key.currency0);
            vm.serializeAddress(o, "currency1", s.key.currency1);
            string memory so = vm.serializeBytes32(o, "poolId", s.poolId);
            stocks = vm.serializeString("stocks", s.symbol, so);
        }
        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        // First block the indexer must scan (app/src/indexer uses it as fromBlock). vm.getBlockNumber, not
        // block.number: on Arbitrum Orbit block.number is the parent-chain block, not the L2 block.
        vm.serializeUint(root, "deployBlock", vm.getBlockNumber());
        vm.serializeAddress(root, "deployer", d.deployer);
        vm.serializeAddress(root, "poolManager", POOL_MANAGER);
        vm.serializeAddress(root, "usdg", address(d.usdg));
        vm.serializeAddress(root, "stockTokenRegistry", address(d.registry));
        vm.serializeAddress(root, "valuer", address(d.valuer));
        vm.serializeAddress(root, "stockRouter", address(d.router));
        vm.serializeAddress(root, "jitterBeacon", address(d.beacon));
        vm.serializeAddress(root, "poolSeeder", address(d.seeder));
        // The feeds are MockFeeds the deployer can set: the keeper's refresh-mock-feeds job keys off this flag.
        vm.serializeBool(root, "mockFeeds", true);
        string memory json = vm.serializeString(root, "stocks", stocks);
        // TESTNET_KIT_FILE: another file name inside app/deployments (tests; fs_permissions allow nothing else).
        string memory file = vm.envOr("TESTNET_KIT_FILE", string.concat(vm.toString(block.chainid), ".json"));
        vm.writeJson(json, string.concat(dir, "/", file));
    }
}
