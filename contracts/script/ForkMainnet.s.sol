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
import {TestnetPoolSeeder} from "../src/testnet/TestnetPoolSeeder.sol";
import {TestnetPoolMath} from "../src/testnet/TestnetPoolMath.sol";

/// LOCAL MAINNET FORK ONLY. The whole Plynth stack on an anvil fork of Robinhood Chain mainnet that runs under
/// chain id 31337 (`anvil --fork-url <4663 rpc> --chain-id 31337`), wired to the REAL mainnet contracts: USDG,
/// the nine Stock Tokens that have Chainlink feeds (feeds price one token: multiplierEmbedded = true), their
/// default Uniswap v4 USDG pools on the real PoolManager, Permit2, the ERC-5564 Announcer / ERC-6538 Registry
/// and the Steakhouse USDG vault (steakUSDG). Addresses: docs chain facts, verified 2026-10-04.
///
/// Chain id 31337 is deliberate: every EIP-712 signature made on the fork names chain 31337, so none of them
/// can be replayed on the real chain (4663). The script refuses to run anywhere else.
///
/// Fork-only settings (never use them on a real chain):
///   - Valuer MAX_STALENESS = FORK_MAX_STALENESS (default 7 days). A fork freezes Chainlink at the fork block
///     and the real feeds do not update off-hours either; 7 days keeps a weekend fork usable for warped tests.
///   - CrowdBuy MIN_CROWD = 3.
///   - Hidden Vault caps (USDG, every listed Stock Token, steakUSDG shares) and the steakUSDG park adapter are
///     PROPOSED here; they apply after the 48h timelocks (`applyCap` / `applyAdapter`, anyone).
///
/// The deployer must hold at least USDG_NEEDED real USDG before it runs (the fork setup moves it from a large
/// holder by impersonation): 50k for the PLTH/USDG pool and LP_SEED for the perp pool.
///
/// Env: FORK_KEEPER, FORK_ATTESTER, FORK_COMMITTEE (template review + insurance committee), optional
/// FORK_MAX_STALENESS, FORK_MIN_CROWD. Writes app/deployments/fork.json (gitignored).
contract ForkMainnet is Script {
    // ---- real Robinhood Chain mainnet contracts (chain facts, verified 2026-10-04)
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address public constant REGISTRY_6538 = 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538;
    address public constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    uint256 public constant FORK_CHAIN_ID = 31337;
    uint16 public constant CROWD_SLIPPAGE_BPS = 100;
    uint256 public constant PLTH_USDG_PER_SIDE = 50_000e6;
    uint256 public constant PLTH_PRICE = 0.05e18;
    uint256 public constant LP_SEED = 1_000_000e6;
    uint256 public constant USDG_NEEDED = PLTH_USDG_PER_SIDE * 101 / 100 + LP_SEED;
    uint256 public constant HIDDEN_USDG_CAP = 1e12; // 1M USDG
    uint256 public constant HIDDEN_STOCK_CAP = 1e24;
    uint256 public constant HIDDEN_PARK_CAP = 1e24; // steakUSDG shares (18 dp)

    struct Stock {
        string sym;
        address token;
        address feed;
        uint24 fee;
        int24 tickSpacing;
    }

    error NotFork(uint256 chainId);
    error MissingCode(address what);
    error NotEnoughUsdg(uint256 have, uint256 need);

    // Outputs (script storage: keeps every function's stack small).
    address deployer;
    address keeper;
    address attester;
    address committee;
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
    uint256 startBlock;
    address[] perpMarkets;
    string[] perpSymbols;

    function stocks() public pure returns (Stock[] memory s) {
        s = new Stock[](9);
        s[0] = Stock("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 0x4A1166a659A55625345e9515b32adECea5547C38, 3000, 60);
        s[1] = Stock("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0, 3000, 60);
        s[2] = Stock("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15, 100, 1);
        s[3] = Stock("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C, 2500, 25);
        s[4] = Stock("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E, 3000, 60);
        s[5] = Stock("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 0xF6f373a037c30F0e5010d854385cA89185AE638b, 300, 3);
        s[6] = Stock("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 0x7C38C00C30BEe9378381E7B6135d7283356D71b1, 310, 3);
        s[7] = Stock("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 0x396118bdFB181e6240E74D243F266B061c0edc3D, 2400, 24);
        s[8] = Stock("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 0x319724394D3A0e3669269846abE664Cd621f9f6A, 500, 5);
    }

    /// The hookless default pool of a Stock Token (chain facts): currencies sorted by address.
    function poolKeyOf(Stock memory s) public pure returns (PoolKey memory) {
        (address c0, address c1) = USDG < s.token ? (USDG, s.token) : (s.token, USDG);
        return PoolKey(c0, c1, s.fee, s.tickSpacing, IHooks(address(0)));
    }

    function run() external {
        if (block.chainid != FORK_CHAIN_ID) revert NotFork(block.chainid);
        address[7] memory real = [USDG, POOL_MANAGER, PERMIT2, ANNOUNCER, REGISTRY_6538, STEAK_USDG, MULTICALL3];
        for (uint256 i; i < real.length; ++i) {
            if (real[i].code.length == 0) revert MissingCode(real[i]);
        }
        keeper = vm.envAddress("FORK_KEEPER");
        attester = vm.envAddress("FORK_ATTESTER");
        committee = vm.envAddress("FORK_COMMITTEE");
        startBlock = vm.getBlockNumber();

        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        uint256 bal = IERC20(USDG).balanceOf(deployer);
        if (bal < USDG_NEEDED) revert NotEnoughUsdg(bal, USDG_NEEDED);
        _core();
        _token();
        _treasury();
        _consumer();
        _hidden();
        _perps();
        vm.stopBroadcast();
        _write();
    }

    function _core() private {
        registry = new StockTokenRegistry(deployer);
        valuer = new Valuer(registry, vm.envOr("FORK_MAX_STALENESS", uint256(7 days)));
        router = new StockRouter(IPoolManager(POOL_MANAGER), registry, valuer, IERC20Metadata(USDG), deployer);
        Stock[] memory s = stocks();
        for (uint256 i; i < s.length; ++i) {
            registry.list(s[i].token, s[i].feed, true);
            router.setPool(s[i].token, poolKeyOf(s[i]));
        }
        eligibility = new EligibilityRegistry(deployer, attester);
    }

    function _token() private {
        plth = new PLTH(deployer, deployer, deployer);
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(USDG), _tiers(), 7 days);
        insurance = new ExceptionInsurancePool(IERC20Metadata(USDG), committee, 14 days);
        TestnetPoolSeeder seeder = new TestnetPoolSeeder(IPoolManager(POOL_MANAGER));
        bool usdgIs0 = USDG < address(plth);
        plthKey = usdgIs0
            ? PoolKey(USDG, address(plth), 3000, 60, IHooks(address(0)))
            : PoolKey(address(plth), USDG, 3000, 60, IHooks(address(0)));
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(PLTH_PRICE, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, PLTH_USDG_PER_SIDE, usdgIs0);
        uint256 plthNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);
        IERC20(USDG).transfer(address(seeder), PLTH_USDG_PER_SIDE * 101 / 100);
        IERC20(address(plth)).transfer(address(seeder), plthNeed * 101 / 100);
        (plthPoolId,) = seeder.seed(plthKey, sqrtP, liq);
        feeRouter = new FeeRouter(
            IERC20(USDG),
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

    /// Same four tiers as the testnet token kit: 0 / 10k / 100k / 1M PLTH.
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
        address policyImpl = address(new TreasuryPolicy(address(0), none, 48 hours));
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
        // Platform fees go to the FeeRouter (stakers, insurance, PLTH buyback, template authors).
        factory = new TreasuryFactory(
            policyImpl,
            accountImpl,
            closeImpl,
            approvalsImpl,
            guard,
            IERC20Metadata(USDG),
            address(feeRouter),
            ITierSource(address(staking)),
            templates
        );
        insurance.bindTreasuryFactory(address(factory)); // only this factory's treasuries may claim (L-7)
        feeRouter.setTemplateFees(ITemplateFeeSource(address(factory)), 2000);
        feeRouter.setKeeper(keeper); // push and observe are keeper-only
        IERC4626[] memory vaults = new IERC4626[](1);
        vaults[0] = IERC4626(STEAK_USDG);
        cashSleeve = new CashSleeve(valuer, IERC20(USDG), vaults);
        Stock[] memory s = stocks();
        address[] memory tokens = new address[](s.length);
        for (uint256 i; i < s.length; ++i) {
            tokens[i] = s[i].token;
        }
        equitySleeve = new EquitySleeve(router, tokens);
    }

    function _consumer() private {
        beacon = new JitterBeacon(keeper, deployer, 1 hours);
        vault = new SavingsVault(IERC20(USDG), PERMIT2, ICanonicalRegistry(address(registry)), deployer, keeper);
        vault.setEligibility(IEligibility(address(eligibility)));
        genesis = uint64(block.timestamp - (block.timestamp % 1 days));
        crowd = new CrowdBuy(
            vault,
            router,
            IExecuteBeacon(address(beacon)),
            uint32(vm.envOr("FORK_MIN_CROWD", uint256(3))),
            CROWD_SLIPPAGE_BPS,
            genesis,
            deployer,
            keeper, 1 days
        );
        vault.setCrowd(address(crowd));
        stealthClaims =
            new StealthClaims(address(crowd), IERC5564Announcer(ANNOUNCER), IERC6538Registry(REGISTRY_6538));
        crowd.setStealthClaims(stealthClaims);
    }

    function _hidden() private {
        shieldedPool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), deployer, 48 hours
        );
        shieldedPool.setCrowd(address(crowd));
        shieldedTrade = new ShieldedTrade(
            shieldedPool,
            IHonkVerifier(address(new SwapVerifier())),
            IHonkVerifier(address(new SettleVerifier())),
            router,
            deployer, 48 hours
        );
        shieldedPool.setTrade(address(shieldedTrade));
        crowd.setShieldedPool(IShieldedDeposit(address(shieldedPool)));
        parkAdapter = new ERC4626Park(IERC4626(STEAK_USDG), USDG);
        shieldedTrade.proposeAdapter(IParkAdapter(address(parkAdapter)));
        shieldedPool.proposeCap(USDG, HIDDEN_USDG_CAP);
        shieldedPool.setMinDeposit(USDG, 1e6); // 1 USDG: no dust notes to fill the tree with
        shieldedPool.proposeCap(STEAK_USDG, HIDDEN_PARK_CAP);
        Stock[] memory s = stocks();
        for (uint256 i; i < s.length; ++i) {
            shieldedPool.proposeCap(s[i].token, HIDDEN_STOCK_CAP);
        }
        thresholdVerifier = new ThresholdVerifier(
            shieldedPool,
            IHonkVerifier(address(new ThresholdHoldingsVerifier())),
            IHonkVerifier(address(new ThresholdSavingsVerifier()))
        );
    }

    /// In-house perp venue: one PerpPool over real USDG and a market for each of the four deepest names,
    /// priced by the same Valuer (real feeds), seeded with LP_SEED of the deployer's USDG.
    function _perps() private {
        // Fork only: a 1 h perps timelock so the exercise can apply a param change and stay inside the fork's 7-day
        // feed staleness (mainnet: 48 h, MainnetBeta).
        perpPool = new PerpPool(IERC20(USDG), deployer, 24 hours, 1 hours);
        Stock[] memory s = stocks();
        uint256[4] memory pick = [uint256(0), 1, 2, 8]; // TSLA, AAPL, NVDA, SPY
        for (uint256 i; i < pick.length; ++i) {
            PerpMarket m = new PerpMarket(perpPool, valuer, s[pick[i]].token, deployer);
            perpPool.addMarket(address(m));
            perpMarkets.push(address(m));
            perpSymbols.push(s[pick[i]].sym);
        }
        IERC20(USDG).approve(address(perpPool), LP_SEED);
        perpPool.deposit(LP_SEED, deployer);
    }

    function _write() private {
        string memory st = "stocks";
        string memory stocksJson;
        Stock[] memory s = stocks();
        for (uint256 i; i < s.length; ++i) {
            string memory k = string.concat("stock_", s[i].sym);
            vm.serializeAddress(k, "token", s[i].token);
            vm.serializeAddress(k, "feed", s[i].feed);
            PoolKey memory key = poolKeyOf(s[i]);
            vm.serializeAddress(k, "currency0", key.currency0);
            vm.serializeAddress(k, "currency1", key.currency1);
            vm.serializeUint(k, "fee", s[i].fee);
            vm.serializeInt(k, "tickSpacing", s[i].tickSpacing);
            string memory one = vm.serializeBytes32(k, "poolId", keccak256(abi.encode(key)));
            stocksJson = vm.serializeString(st, s[i].sym, one);
        }
        string memory pm = "perpMarkets";
        string memory perpJson;
        for (uint256 i; i < perpMarkets.length; ++i) {
            perpJson = vm.serializeAddress(pm, perpSymbols[i], perpMarkets[i]);
        }

        string memory r = "fork";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", startBlock + 1);
        vm.serializeBool(r, "fork", true);
        vm.serializeBool(r, "mockFeeds", false);
        vm.serializeAddress(r, "deployer", deployer);
        vm.serializeAddress(r, "keeper", keeper);
        vm.serializeAddress(r, "attester", attester);
        vm.serializeAddress(r, "committee", committee);
        vm.serializeAddress(r, "usdg", USDG);
        vm.serializeAddress(r, "poolManager", POOL_MANAGER);
        vm.serializeAddress(r, "permit2", PERMIT2);
        vm.serializeAddress(r, "multicall3", MULTICALL3);
        vm.serializeAddress(r, "erc5564Announcer", ANNOUNCER);
        vm.serializeAddress(r, "erc6538Registry", REGISTRY_6538);
        vm.serializeAddress(r, "steakUsdg", STEAK_USDG);
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
        vm.serializeAddress(r, "parkVault", STEAK_USDG);
        vm.serializeAddress(r, "thresholdVerifier", address(thresholdVerifier));
        vm.serializeAddress(r, "policyGuard", address(guard));
        vm.serializeAddress(r, "templateRegistry", address(templates));
        vm.serializeAddress(r, "receipts", address(receipts));
        vm.serializeAddress(r, "treasuryFactory", address(factory));
        vm.serializeAddress(r, "cashSleeve", address(cashSleeve));
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
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../app/deployments/fork.json"));
    }
}
