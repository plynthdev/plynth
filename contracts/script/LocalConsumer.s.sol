// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {SavingsVault, ICanonicalRegistry} from "../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon} from "../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../src/consumer/StealthClaims.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {IShieldedDeposit} from "../src/consumer/CrowdBuy.sol";
import {TransferVerifier} from "../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/consumer/verifiers/WithdrawVerifier.sol";
import {ThresholdVerifier} from "../src/consumer/ThresholdVerifier.sol";
import {ShieldedTrade} from "../src/consumer/ShieldedTrade.sol";
import {SwapVerifier} from "../src/consumer/verifiers/SwapVerifier.sol";
import {SettleVerifier} from "../src/consumer/verifiers/SettleVerifier.sol";
import {ERC4626Park} from "../src/consumer/park/ERC4626Park.sol";
import {IParkAdapter} from "../src/consumer/park/IParkAdapter.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MockUsdgVault} from "../test/mocks/MockUsdgVault.sol";
import {ThresholdHoldingsVerifier} from "../src/consumer/verifiers/ThresholdHoldingsVerifier.sol";
import {ThresholdSavingsVerifier} from "../src/consumer/verifiers/ThresholdSavingsVerifier.sol";
import {IERC5564Announcer} from "../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../src/interfaces/IERC6538Registry.sol";
import {StockTokenRegistry} from "../src/core/StockTokenRegistry.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {StockRouter} from "../src/core/StockRouter.sol";
import {JitterBeacon} from "../src/core/JitterBeacon.sol";
import {IHooks, IPoolManager, PoolKey} from "../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {MockFeed} from "../src/testnet/MockFeed.sol";
import {MockPoolManager, MockStockERC20} from "../test/mocks/MockV4.sol";
import {Multicall3Lite} from "../test/mocks/Multicall3Lite.sol";

/// LOCAL ANVIL ONLY (chain 31337). The whole consumer stack on a plain anvil chain for keeper end-to-end
/// tests: mock USDG, two mock Stock Tokens with feeds, a fixed-rate mock v4 PoolManager, the core
/// contracts, SavingsVault + CrowdBuy, and a Multicall3 stand-in. Permit2 must already be at its canonical
/// address (the test etches the real runtime with anvil_setCode first). If the ERC-5564 Announcer and ERC-6538
/// Registry are also etched at their canonical addresses, StealthClaims is deployed and wired for Quiet delivery.
/// The Hidden Vault (ShieldedPool + real verifiers) is always deployed and wired to CrowdBuy; caps for mUSDG and
/// both stocks are proposed here and apply 48h later (`applyCap`), exactly as on any other chain.
///
/// ShieldedTrade (private sell/buy/park, real swap + settle verifiers) is set on the pool, with one ERC4626Park
/// over a mock USDG ERC-4626 vault proposed (applies after 48h via applyAdapter) and a cap proposed for its shares.
///
/// Env: KEEPER_ADDRESS (required), MIN_CROWD (default 3), MAX_STALENESS (seconds, default 3650 days: the
/// tests warp time by weeks and the feeds are not refreshed).
/// Prints one line `PLYNTH_DEPLOYMENT <json>` with every address; nothing is written to disk.
contract LocalConsumer is Script {
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address public constant REGISTRY_6538 = 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538;
    uint24 public constant FEE = 500;
    uint16 public constant SLIPPAGE_BPS = 100;

    error OnlyLocal(uint256 chainId);
    error NoPermit2();

    struct Out {
        address usdg;
        address registry;
        address valuer;
        address poolManager;
        address router;
        address beacon;
        address vault;
        address crowd;
        address stealthClaims;
        address shieldedPool;
        address shieldedTrade;
        address parkVault;
        address parkAdapter;
        address thresholdVerifier;
        address multicall3;
        address tsla;
        address nvda;
        address feedTsla;
        address feedNvda;
        uint64 genesis;
    }

    function run() external returns (Out memory o) {
        if (block.chainid != 31337) revert OnlyLocal(block.chainid);
        if (PERMIT2.code.length == 0) revert NoPermit2();
        uint256 startBlock = vm.getBlockNumber();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        _core(o, deployer);
        _consumer(o, deployer);
        (o.tsla, o.feedTsla) = _stock(o, "mTSLA", 250e18);
        (o.nvda, o.feedNvda) = _stock(o, "mNVDA", 37e18);
        MockUSDG(o.usdg).mint(o.poolManager, 1e15);
        _hidden(o, deployer);
        o.multicall3 = address(new Multicall3Lite());
        vm.stopBroadcast();
        _print(o, startBlock);
    }

    function _core(Out memory o, address deployer) private {
        o.usdg = address(new MockUSDG());
        StockTokenRegistry registry = new StockTokenRegistry(deployer);
        o.registry = address(registry);
        Valuer valuer = new Valuer(registry, vm.envOr("MAX_STALENESS", uint256(3650 days)));
        o.valuer = address(valuer);
        o.poolManager = address(new MockPoolManager());
        o.router = address(
            new StockRouter(IPoolManager(o.poolManager), registry, valuer, IERC20Metadata(o.usdg), deployer)
        );
    }

    function _consumer(Out memory o, address deployer) private {
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        o.beacon = address(new JitterBeacon(keeper, deployer));
        SavingsVault vault =
            new SavingsVault(IERC20(o.usdg), PERMIT2, ICanonicalRegistry(o.registry), deployer, keeper);
        o.vault = address(vault);
        // Genesis on a whole day boundary at or before now, so windows line up with UTC days.
        o.genesis = uint64(block.timestamp - (block.timestamp % 1 days));
        o.crowd = address(
            new CrowdBuy(
                vault,
                StockRouter(o.router),
                IExecuteBeacon(o.beacon),
                uint32(vm.envOr("MIN_CROWD", uint256(3))),
                SLIPPAGE_BPS,
                o.genesis,
                deployer,
                keeper
            )
        );
        vault.setCrowd(o.crowd);
        if (ANNOUNCER.code.length != 0 && REGISTRY_6538.code.length != 0) {
            StealthClaims sc =
                new StealthClaims(o.crowd, IERC5564Announcer(ANNOUNCER), IERC6538Registry(REGISTRY_6538));
            CrowdBuy(o.crowd).setStealthClaims(sc);
            o.stealthClaims = address(sc);
        }
    }

    function _hidden(Out memory o, address deployer) private {
        // Same steps as HiddenVault.s.sol (local chain only, so the caps are non-zero).
        address[] memory assets = new address[](3);
        (assets[0], assets[1], assets[2]) = (o.usdg, o.tsla, o.nvda);
        uint256[] memory caps = new uint256[](3);
        (caps[0], caps[1], caps[2]) = (1e12, 1e24, 1e24);
        ShieldedPool pool = ShieldedPool(_deployHidden(deployer, o.crowd, assets, caps));
        CrowdBuy(o.crowd).setShieldedPool(IShieldedDeposit(address(pool)));
        o.shieldedPool = address(pool);
        _trade(o, pool, deployer);
        // Same as ThresholdProofs.s.sol.
        o.thresholdVerifier = address(
            new ThresholdVerifier(
                pool,
                IHonkVerifier(address(new ThresholdHoldingsVerifier())),
                IHonkVerifier(address(new ThresholdSavingsVerifier()))
            )
        );
    }

    function _trade(Out memory o, ShieldedPool pool, address owner) private {
        ShieldedTrade trade = new ShieldedTrade(
            pool,
            IHonkVerifier(address(new SwapVerifier())),
            IHonkVerifier(address(new SettleVerifier())),
            StockRouter(o.router),
            owner
        );
        pool.setTrade(address(trade));
        o.shieldedTrade = address(trade);
        o.parkVault = address(new MockUsdgVault(IERC20(o.usdg)));
        ERC4626Park park = new ERC4626Park(IERC4626(o.parkVault), o.usdg);
        o.parkAdapter = address(park);
        trade.proposeAdapter(IParkAdapter(address(park)));
        pool.proposeCap(o.parkVault, type(uint128).max);
    }

    function _deployHidden(address owner, address crowd, address[] memory assets, uint256[] memory caps)
        private
        returns (address)
    {
        ShieldedPool pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), owner
        );
        pool.setCrowd(crowd);
        for (uint256 i; i < assets.length; ++i) {
            pool.proposeCap(assets[i], caps[i]);
        }
        return address(pool);
    }

    function _stock(Out memory o, string memory sym, uint256 usdPerToken) private returns (address, address) {
        address usdg = o.usdg;
        StockRouter router = StockRouter(o.router);
        MockPoolManager pm = MockPoolManager(o.poolManager);
        MockStockERC20 tok = new MockStockERC20(sym, 18);
        MockFeed feed = new MockFeed(8, int256(usdPerToken / 1e10), string.concat(sym, " / USD (local mock)"));
        StockTokenRegistry(o.registry).list(address(tok), address(feed), true);
        (address c0, address c1) = usdg < address(tok) ? (usdg, address(tok)) : (address(tok), usdg);
        PoolKey memory key = PoolKey(c0, c1, FEE, 10, IHooks(address(0)));
        router.setPool(address(tok), key);
        if (c0 == usdg) pm.setRate(key, 1e18 * 1e18 * 1e18 / (usdPerToken * 1e6));
        else pm.setRate(key, usdPerToken * 1e6 / 1e18);
        tok.mint(address(pm), 1e27);
        return (address(tok), address(feed));
    }

    function _print(Out memory o, uint256 startBlock) private {
        string memory s = "mTSLA";
        string memory tsla = vm.serializeAddress(s, "token", o.tsla);
        tsla = vm.serializeAddress(s, "feed", o.feedTsla);
        string memory n = "mNVDA";
        string memory nvda = vm.serializeAddress(n, "token", o.nvda);
        nvda = vm.serializeAddress(n, "feed", o.feedNvda);
        vm.serializeString("stocks", "mTSLA", tsla);
        string memory stocks = vm.serializeString("stocks", "mNVDA", nvda);

        string memory r = "root";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", startBlock + 1);
        vm.serializeAddress(r, "usdg", o.usdg);
        vm.serializeAddress(r, "stockTokenRegistry", o.registry);
        vm.serializeAddress(r, "valuer", o.valuer);
        vm.serializeAddress(r, "poolManager", o.poolManager);
        vm.serializeAddress(r, "stockRouter", o.router);
        vm.serializeAddress(r, "jitterBeacon", o.beacon);
        vm.serializeAddress(r, "savingsVault", o.vault);
        vm.serializeAddress(r, "crowdBuy", o.crowd);
        vm.serializeAddress(r, "multicall3", o.multicall3);
        vm.serializeAddress(r, "shieldedPool", o.shieldedPool);
        vm.serializeAddress(r, "thresholdVerifier", o.thresholdVerifier);
        vm.serializeAddress(r, "shieldedTrade", o.shieldedTrade);
        vm.serializeAddress(r, "parkVault", o.parkVault);
        vm.serializeAddress(r, "parkAdapter", o.parkAdapter);
        if (o.stealthClaims != address(0)) {
            vm.serializeAddress(r, "stealthClaims", o.stealthClaims);
            vm.serializeAddress(r, "erc5564Announcer", ANNOUNCER);
            vm.serializeAddress(r, "erc6538Registry", REGISTRY_6538);
        }
        vm.serializeAddress(r, "permit2", PERMIT2);
        vm.serializeUint(r, "genesis", o.genesis);
        string memory json = vm.serializeString(r, "stocks", stocks);
        console.log(string.concat("PLYNTH_DEPLOYMENT ", json));
    }
}
