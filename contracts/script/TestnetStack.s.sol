// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {StockTokenRegistry} from "../src/core/StockTokenRegistry.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {StockRouter} from "../src/core/StockRouter.sol";
import {JitterBeacon} from "../src/core/JitterBeacon.sol";
import {EligibilityRegistry} from "../src/core/EligibilityRegistry.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IHooks, IPoolManager, PoolKey} from "../src/interfaces/IUniswapV4.sol";
import {IERC5564Announcer} from "../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../src/interfaces/IERC6538Registry.sol";
import {IParkAdapter} from "../src/interfaces/IParkAdapter.sol";
import {ITierSource, Tier} from "../src/interfaces/ITierSource.sol";

import {SavingsVault, ICanonicalRegistry} from "../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon, IShieldedDeposit} from "../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../src/consumer/StealthClaims.sol";
import {ShieldedPool, IHonkVerifier} from "../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../src/consumer/ShieldedTrade.sol";
import {ThresholdVerifier} from "../src/consumer/ThresholdVerifier.sol";
import {ERC4626Park} from "../src/consumer/park/ERC4626Park.sol";
import {TransferVerifier} from "../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/consumer/verifiers/WithdrawVerifier.sol";
import {SwapVerifier} from "../src/consumer/verifiers/SwapVerifier.sol";
import {SettleVerifier} from "../src/consumer/verifiers/SettleVerifier.sol";
import {ThresholdHoldingsVerifier} from "../src/consumer/verifiers/ThresholdHoldingsVerifier.sol";
import {ThresholdSavingsVerifier} from "../src/consumer/verifiers/ThresholdSavingsVerifier.sol";

import {TreasuryPolicy} from "../src/treasury/TreasuryPolicy.sol";
import {TreasuryAccount} from "../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../src/treasury/PolicyGuard.sol";
import {PeriodClose} from "../src/treasury/PeriodClose.sol";
import {BoardApprovals} from "../src/treasury/BoardApprovals.sol";
import {TreasuryFactory} from "../src/treasury/TreasuryFactory.sol";
import {TemplateRegistry} from "../src/treasury/TemplateRegistry.sol";
import {Receipts} from "../src/treasury/Receipts.sol";
import {CashSleeve} from "../src/treasury/sleeves/CashSleeve.sol";
import {EquitySleeve} from "../src/treasury/sleeves/EquitySleeve.sol";

import {PerpPool} from "../src/perps/PerpPool.sol";
import {PerpMarket} from "../src/perps/PerpMarket.sol";

import {PLTH} from "../src/token/PLTH.sol";
import {PlinthStaking} from "../src/token/PlinthStaking.sol";
import {FeeRouter, IStakingRewards, IInsuranceFees, ITemplateFeeSource} from "../src/token/FeeRouter.sol";
import {ExceptionInsurancePool} from "../src/token/ExceptionInsurancePool.sol";

import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../src/testnet/MockStockToken.sol";
import {MockFeed} from "../src/testnet/MockFeed.sol";
import {TestnetPoolSeeder} from "../src/testnet/TestnetPoolSeeder.sol";
import {TestnetPoolMath} from "../src/testnet/TestnetPoolMath.sol";
import {MockUsdgVault} from "../test/mocks/MockUsdgVault.sol";

/// ROBINHOOD CHAIN TESTNET (46630) ONLY. The whole Plynth stack in one script, the testnet twin of
/// ForkMainnet.s.sol: what exists only on mainnet is replaced by the testnet kit's mocks (MockUSDG, three mock
/// Stock Tokens priced per share by MockFeeds, a mock ERC-4626 USDG vault for the cash sleeve and the Hidden Vault
/// park); everything else is real: the chain's Uniswap v4 PoolManager (one pool per mock stock and PLTH/mUSDG),
/// Permit2, the ERC-5564 Announcer and ERC-6538 Registry.
///
/// Refuses every chain but 46630. In particular it can never run on mainnet (4663).
///
/// Settings: CrowdBuy MIN_CROWD = 3; Valuer staleness 30 min (the keeper's refresh-mock-feeds job keeps the feeds
/// fresh from the real mainnet feeds); Hidden Vault caps and the park adapter are PROPOSED (48h timelock, then
/// `applyCap` / `applyAdapter`, anyone).
///
/// Env: TESTNET_KEEPER, TESTNET_ATTESTER, TESTNET_COMMITTEE (template review + insurance committee), optional
/// TESTNET_PRICE_<mTSLA|mAAPL|mSPY> (per-share price, 8 dp; defaults 250/230/570 like TestnetKit, the setup passes
/// today's real mainnet prices so the first keeper pass needs no large pool alignment), TESTNET_MIN_CROWD.
/// Writes app/deployments/46630.json in the fork.json schema plus `mockFeeds: true` (the setup script rewrites
/// deployBlock to the L2 block: forge reads the parent-chain block number on Orbit).
contract TestnetStack is Script {
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address public constant REGISTRY_6538 = 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538;
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    uint256 public constant TESTNET_CHAIN_ID = 46630;
    uint256 public constant MAX_STALENESS = 30 minutes;
    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint16 public constant CROWD_SLIPPAGE_BPS = 100;
    uint256 public constant USDG_PER_POOL_SIDE = 50_000e6;
    uint256 public constant PLTH_USDG_PER_SIDE = 50_000e6;
    uint256 public constant PLTH_PRICE = 0.05e18;
    uint256 public constant LP_SEED = 1_000_000e6;
    uint256 public constant DEPLOYER_FLOAT = 10_000_000e6; // mUSDG the deployer keeps for funding testers
    uint256 public constant HIDDEN_USDG_CAP = 1e12; // 1M mUSDG
    uint256 public constant HIDDEN_STOCK_CAP = 1e24;
    uint256 public constant HIDDEN_PARK_CAP = 1e24; // mock vault shares (12 dp)
    // Testnet-only short timers so every time-bound step finishes the same day (mainnet/fork keep 1 day,
    // 1 hour, 48 hours, 7 days, 14 days, 24 hours; each contract enforces its own hard minimum).
    uint64 public constant CROWD_WINDOW = 2 hours;
    uint64 public constant BEACON_GRACE = 15 minutes;
    uint64 public constant SHORT_DELAY = 15 minutes; // cap/adapter/policy timelocks, unbonding, insurance, LP cooldown

    struct Stock {
        string sym;
        string underlying;
        string name;
        uint256 multiplier;
        int256 defaultPrice;
        MockStockToken token;
        MockFeed feed;
        PoolKey key;
        bytes32 poolId;
    }

    error NotTestnet(uint256 chainId);
    error MissingCode(address what);

    address deployer;
    address keeper;
    address attester;
    address committee;
    MockUSDG usdg;
    MockUsdgVault cashVault;
    TestnetPoolSeeder seeder;
    StockTokenRegistry registry;
    Valuer valuer;
    StockRouter router;
    EligibilityRegistry eligibility;
    JitterBeacon beacon;
    SavingsVault vault;
    CrowdBuy crowd;
    StealthClaims stealthClaims;
    ShieldedPool shieldedPool;
    ShieldedTrade shieldedTrade;
    ERC4626Park parkAdapter;
    ThresholdVerifier thresholdVerifier;
    PolicyGuard guard;
    TemplateRegistry templates;
    Receipts receipts;
    TreasuryFactory factory;
    CashSleeve cashSleeve;
    EquitySleeve equitySleeve;
    PerpPool perpPool;
    PLTH plth;
    PlinthStaking staking;
    ExceptionInsurancePool insurance;
    FeeRouter feeRouter;
    PoolKey plthKey;
    bytes32 plthPoolId;
    uint64 genesis;
    Stock[] stocks;
    address[] perpMarkets;

    function run() external {
        if (block.chainid != TESTNET_CHAIN_ID) revert NotTestnet(block.chainid);
        address[5] memory real = [POOL_MANAGER, PERMIT2, ANNOUNCER, REGISTRY_6538, MULTICALL3];
        for (uint256 i; i < real.length; ++i) {
            if (real[i].code.length == 0) revert MissingCode(real[i]);
        }
        keeper = vm.envAddress("TESTNET_KEEPER");
        attester = vm.envAddress("TESTNET_ATTESTER");
        committee = vm.envAddress("TESTNET_COMMITTEE");

        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        _core();
        _token();
        _treasury();
        _consumer();
        _hidden();
        _perps();
        usdg.mint(deployer, DEPLOYER_FLOAT);
        vm.stopBroadcast();
        _write();
    }

    function _core() private {
        usdg = new MockUSDG();
        registry = new StockTokenRegistry(deployer);
        valuer = new Valuer(registry, MAX_STALENESS);
        router = new StockRouter(IPoolManager(POOL_MANAGER), registry, valuer, IERC20Metadata(address(usdg)), deployer);
        seeder = new TestnetPoolSeeder(IPoolManager(POOL_MANAGER));
        _stock("mTSLA", "TSLA", "Mock Tesla", 1e18, 250e8);
        _stock("mAAPL", "AAPL", "Mock Apple", 1.0005e18, 230e8);
        _stock("mSPY", "SPY", "Mock SPDR S&P 500", 1.0017e18, 570e8);
        eligibility = new EligibilityRegistry(deployer, attester);
        cashVault = new MockUsdgVault(IERC20(address(usdg)));
    }

    /// Same as TestnetKit._stock: feeds price one SHARE (8 dp), the registry lists them with
    /// multiplierEmbedded = false, the pool starts at the Valuer price and gets 50k mUSDG a side.
    function _stock(string memory sym, string memory underlying, string memory name, uint256 mult, int256 dflt)
        private
    {
        Stock memory s;
        s.sym = sym;
        s.underlying = underlying;
        s.name = name;
        s.multiplier = mult;
        s.defaultPrice = dflt;
        s.token = new MockStockToken(name, sym);
        if (mult != 1e18) s.token.setUiMultiplier(mult);
        s.feed = new MockFeed(8, vm.envOr(string.concat("TESTNET_PRICE_", sym), dflt), string.concat(sym, " / USD (mock, per share)"));
        registry.list(address(s.token), address(s.feed), false);
        bool usdgIs0 = address(usdg) < address(s.token);
        s.key = usdgIs0
            ? PoolKey(address(usdg), address(s.token), FEE, TICK_SPACING, IHooks(address(0)))
            : PoolKey(address(s.token), address(usdg), FEE, TICK_SPACING, IHooks(address(0)));
        uint256 p = valuer.quote(address(s.token)).priceUsdPerToken;
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(p, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, USDG_PER_POOL_SIDE, usdgIs0);
        uint256 tokenNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);
        usdg.mint(address(seeder), USDG_PER_POOL_SIDE * 101 / 100);
        s.token.mint(address(seeder), tokenNeed * 101 / 100);
        (s.poolId,) = seeder.seed(s.key, sqrtP, liq);
        router.setPool(address(s.token), s.key);
        stocks.push(s);
    }

    function _token() private {
        plth = new PLTH(deployer, deployer, deployer);
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), _tiers(), SHORT_DELAY);
        insurance = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, SHORT_DELAY);
        bool usdgIs0 = address(usdg) < address(plth);
        plthKey = usdgIs0
            ? PoolKey(address(usdg), address(plth), FEE, TICK_SPACING, IHooks(address(0)))
            : PoolKey(address(plth), address(usdg), FEE, TICK_SPACING, IHooks(address(0)));
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(PLTH_PRICE, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, PLTH_USDG_PER_SIDE, usdgIs0);
        uint256 plthNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);
        usdg.mint(address(seeder), PLTH_USDG_PER_SIDE * 101 / 100);
        IERC20(address(plth)).transfer(address(seeder), plthNeed * 101 / 100);
        (plthPoolId,) = seeder.seed(plthKey, sqrtP, liq);
        feeRouter = new FeeRouter(
            IERC20(address(usdg)),
            IERC20(address(plth)),
            IStakingRewards(address(staking)),
            IInsuranceFees(address(insurance)),
            IPoolManager(POOL_MANAGER),
            plthKey,
            100,
            200e6,
            deployer
        );
        insurance.bindFeeRouter(address(feeRouter));
    }

    /// Same four tiers as ForkMainnet and the testnet token kit: 0 / 10k / 100k / 1M PLTH.
    function _tiers() private pure returns (PlinthStaking.TierSpec[] memory t) {
        t = new PlinthStaking.TierSpec[](4);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        t[1] = PlinthStaking.TierSpec(10_000e18, Tier(4, true, false, 1));
        t[2] = PlinthStaking.TierSpec(100_000e18, Tier(8, true, true, 2));
        t[3] = PlinthStaking.TierSpec(1_000_000e18, Tier(16, true, true, 3));
    }

    function _treasury() private {
        guard = new PolicyGuard(registry, valuer, 200);
        TreasuryPolicy.Policy memory none;
        address policyImpl = address(new TreasuryPolicy(address(0), none, SHORT_DELAY));
        address accountImpl =
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0)));
        address closeImpl = address(
            new PeriodClose(
                TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
            )
        );
        address approvalsImpl = address(new BoardApprovals(address(0), address(0)));
        templates = new TemplateRegistry(committee, ITierSource(address(staking)));
        receipts = new Receipts();
        factory = new TreasuryFactory(
            policyImpl,
            accountImpl,
            closeImpl,
            approvalsImpl,
            guard,
            IERC20Metadata(address(usdg)),
            address(feeRouter),
            ITierSource(address(staking)),
            templates
        );
        insurance.bindTreasuryFactory(address(factory)); // only this factory's treasuries may claim (L-7)
        feeRouter.setTemplateFees(ITemplateFeeSource(address(factory)), 2000);
        feeRouter.setKeeper(keeper); // push and observe are keeper-only
        IERC4626[] memory vaults = new IERC4626[](1);
        vaults[0] = IERC4626(address(cashVault));
        cashSleeve = new CashSleeve(valuer, IERC20(address(usdg)), vaults);
        address[] memory tokens = new address[](stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            tokens[i] = address(stocks[i].token);
        }
        equitySleeve = new EquitySleeve(router, tokens);
        // The adapter allow-list (first-time setup, the deployer owns the factory): the shared sleeves.
        factory.setAdapterAllowed(address(cashSleeve).codehash, true);
        factory.setAdapterAllowed(address(equitySleeve).codehash, true);
    }

    function _consumer() private {
        beacon = new JitterBeacon(keeper, deployer, BEACON_GRACE);
        vault = new SavingsVault(IERC20(address(usdg)), PERMIT2, ICanonicalRegistry(address(registry)), deployer, keeper);
        vault.setEligibility(IEligibility(address(eligibility)));
        genesis = uint64(block.timestamp - (block.timestamp % 1 days));
        crowd = new CrowdBuy(
            vault,
            router,
            IExecuteBeacon(address(beacon)),
            uint32(vm.envOr("TESTNET_MIN_CROWD", uint256(3))),
            CROWD_SLIPPAGE_BPS,
            genesis,
            deployer,
            keeper, CROWD_WINDOW
        );
        vault.setCrowd(address(crowd));
        stealthClaims =
            new StealthClaims(address(crowd), IERC5564Announcer(ANNOUNCER), IERC6538Registry(REGISTRY_6538));
        crowd.setStealthClaims(stealthClaims);
    }

    function _hidden() private {
        shieldedPool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), deployer, SHORT_DELAY
        );
        shieldedPool.setCrowd(address(crowd));
        shieldedTrade = new ShieldedTrade(
            shieldedPool,
            IHonkVerifier(address(new SwapVerifier())),
            IHonkVerifier(address(new SettleVerifier())),
            router,
            deployer, SHORT_DELAY
        );
        shieldedPool.setTrade(address(shieldedTrade));
        crowd.setShieldedPool(IShieldedDeposit(address(shieldedPool)));
        parkAdapter = new ERC4626Park(IERC4626(address(cashVault)), address(usdg));
        shieldedTrade.proposeAdapter(IParkAdapter(address(parkAdapter)));
        shieldedPool.proposeCap(address(usdg), HIDDEN_USDG_CAP);
        shieldedPool.setMinDeposit(address(usdg), 1e6); // 1 USDG: no dust notes to fill the tree with
        shieldedPool.proposeCap(address(cashVault), HIDDEN_PARK_CAP);
        for (uint256 i; i < stocks.length; ++i) {
            shieldedPool.proposeCap(address(stocks[i].token), HIDDEN_STOCK_CAP);
        }
        thresholdVerifier = new ThresholdVerifier(
            shieldedPool,
            IHonkVerifier(address(new ThresholdHoldingsVerifier())),
            IHonkVerifier(address(new ThresholdSavingsVerifier()))
        );
    }

    /// In-house perp venue: one PerpPool over mUSDG and a market per mock stock, seeded with LP_SEED.
    function _perps() private {
        perpPool = new PerpPool(IERC20(address(usdg)), deployer, SHORT_DELAY, SHORT_DELAY);
        for (uint256 i; i < stocks.length; ++i) {
            PerpMarket m = new PerpMarket(perpPool, valuer, address(stocks[i].token), deployer);
            perpPool.addMarket(address(m));
            perpMarkets.push(address(m));
        }
        perpPool.openDeposits();
        usdg.mint(deployer, LP_SEED);
        IERC20(address(usdg)).approve(address(perpPool), LP_SEED);
        perpPool.deposit(LP_SEED, deployer);
    }

    function _write() private {
        string memory stocksJson;
        string memory perpJson;
        for (uint256 i; i < stocks.length; ++i) {
            Stock memory s = stocks[i];
            string memory k = string.concat("stock_", s.sym);
            vm.serializeAddress(k, "token", address(s.token));
            vm.serializeAddress(k, "feed", address(s.feed));
            vm.serializeString(k, "underlying", s.underlying);
            // A string: 1.0005e18 does not survive a JSON number in JavaScript.
            vm.serializeString(k, "uiMultiplier", vm.toString(s.multiplier));
            vm.serializeAddress(k, "currency0", s.key.currency0);
            vm.serializeAddress(k, "currency1", s.key.currency1);
            vm.serializeUint(k, "fee", s.key.fee);
            vm.serializeInt(k, "tickSpacing", s.key.tickSpacing);
            string memory one = vm.serializeBytes32(k, "poolId", s.poolId);
            stocksJson = vm.serializeString("stocks", s.sym, one);
            perpJson = vm.serializeAddress("perpMarkets", s.sym, perpMarkets[i]);
        }
        string memory r = "testnet";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", vm.getBlockNumber());
        vm.serializeBool(r, "fork", false);
        vm.serializeBool(r, "mockFeeds", true);
        vm.serializeAddress(r, "deployer", deployer);
        vm.serializeAddress(r, "keeper", keeper);
        vm.serializeAddress(r, "attester", attester);
        vm.serializeAddress(r, "committee", committee);
        vm.serializeAddress(r, "usdg", address(usdg));
        vm.serializeAddress(r, "poolManager", POOL_MANAGER);
        vm.serializeAddress(r, "permit2", PERMIT2);
        vm.serializeAddress(r, "multicall3", MULTICALL3);
        vm.serializeAddress(r, "erc5564Announcer", ANNOUNCER);
        vm.serializeAddress(r, "erc6538Registry", REGISTRY_6538);
        vm.serializeAddress(r, "poolSeeder", address(seeder));
        vm.serializeAddress(r, "stockTokenRegistry", address(registry));
        vm.serializeAddress(r, "valuer", address(valuer));
        vm.serializeAddress(r, "stockRouter", address(router));
        vm.serializeAddress(r, "eligibilityRegistry", address(eligibility));
        vm.serializeAddress(r, "jitterBeacon", address(beacon));
        vm.serializeAddress(r, "savingsVault", address(vault));
        vm.serializeAddress(r, "crowdBuy", address(crowd));
        vm.serializeAddress(r, "stealthClaims", address(stealthClaims));
        vm.serializeAddress(r, "shieldedPool", address(shieldedPool));
        vm.serializeAddress(r, "shieldedTrade", address(shieldedTrade));
        vm.serializeAddress(r, "parkAdapter", address(parkAdapter));
        vm.serializeAddress(r, "parkVault", address(cashVault));
        vm.serializeAddress(r, "thresholdVerifier", address(thresholdVerifier));
        vm.serializeAddress(r, "policyGuard", address(guard));
        vm.serializeAddress(r, "templateRegistry", address(templates));
        vm.serializeAddress(r, "receipts", address(receipts));
        vm.serializeAddress(r, "treasuryFactory", address(factory));
        vm.serializeAddress(r, "cashSleeve", address(cashSleeve));
        vm.serializeAddress(r, "cashVault", address(cashVault));
        vm.serializeAddress(r, "equitySleeve", address(equitySleeve));
        vm.serializeAddress(r, "perpPool", address(perpPool));
        vm.serializeString(r, "perpMarkets", perpJson);
        vm.serializeAddress(r, "plth", address(plth));
        vm.serializeAddress(r, "staking", address(staking));
        vm.serializeAddress(r, "insurancePool", address(insurance));
        vm.serializeAddress(r, "feeRouter", address(feeRouter));
        vm.serializeBytes32(r, "plthPoolId", plthPoolId);
        vm.serializeUint(r, "genesis", genesis);
        string memory json = vm.serializeString(r, "stocks", stocksJson);
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../app/deployments/", vm.envOr("TESTNET_STACK_FILE", string("46630.json"))));
    }
}
