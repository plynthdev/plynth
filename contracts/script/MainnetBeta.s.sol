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

interface IOwned {
    function owner() external view returns (address);
}

interface IPendingOwned {
    function pendingOwner() external view returns (address);
}

/// The closed-beta deploy of Plynth on Robinhood Chain MAINNET (4663), wired to the real mainnet contracts:
/// USDG, the nine Stock Tokens that have Chainlink feeds (feeds price one token: multiplierEmbedded = true), their
/// default Uniswap v4 USDG pools, Permit2, the ERC-5564 Announcer / ERC-6538 Registry and the Steakhouse USDG
/// vault (steakUSDG).
///
/// Two modes, nothing else:
///   - mainnet (default): refuses unless block.chainid == 4663.
///   - fork (BETA_FORK=true): refuses unless block.chainid == 31337, i.e. an anvil fork of 4663 run under chain id
///     31337 so nothing signed on it can be replayed on the real chain. Used for the dry run only.
///
/// Admin: every owner / committee role ends with OWNER (required env, no default; an EOA or a Safe). Contracts
/// that need setup calls are deployed owned by the deployer, set up, then handed over: one-step Ownable contracts
/// (StockRouter, FeeRouter) belong to OWNER at the end of the run; two-step ones (StockTokenRegistry,
/// SavingsVault, CrowdBuy, ShieldedPool, ShieldedTrade, PerpPool, the PerpMarkets) name OWNER as pendingOwner and
/// OWNER calls acceptOwnership() on each (listed in the output file under "acceptOwnership"). The run ends with
/// a check that the deployer keeps no role anywhere; forge simulates that check before anything is broadcast.
///
/// Bots: KEEPER (CrowdBuy, SavingsVault, JitterBeacon, FeeRouter) and ATTESTER (EligibilityRegistry) are set on
/// chain. RELAYER, CONTROLLER, CASH_DESK and EQUITY_DESK are off-chain or per-treasury roles: they are recorded in
/// the output file for the services and for the first treasury's policy. All must be distinct from each other,
/// from OWNER and from the deployer.
///
/// Timers (mainnet values): crowd window 24 h, beacon GRACE 1 h, treasury policy / Hidden Vault cap / park adapter
/// timelocks 48 h, staking unbonding 7 d, insurance withdraw delay 14 d, perp LP redeem cooldown 24 h.
///
/// Caps: none. Every Hidden Vault asset cap is PROPOSED at type(uint256).max (it applies after the 48 h timelock:
/// anyone calls applyCap(asset)); every perp market's open-interest cap is 100% of pool liquidity (the most the
/// contract accepts; the pool still reserves every trader's maximum payout). The owner keeps the emergency
/// levers: ShieldedPool.setDepositsPaused, and proposeCap with a lower value (applies at once).
///
/// Token (PLTH, staking, FeeRouter, insurance pool, PLTH/USDG pool) only with DEPLOY_TOKEN=true (default false).
/// With it off, platform close fees go to OWNER and there is no tier gating (weekly closes allowed for everyone).
///
/// Env: OWNER, KEEPER, ATTESTER, RELAYER, CONTROLLER, CASH_DESK, EQUITY_DESK (required); DEPLOY_TOKEN, BETA_FORK,
/// MIN_CROWD (default 3), MAX_STALENESS (default 26 h; fork mode: FORK_MAX_STALENESS, default 7 d), BETA_OUT
/// (output file name inside app/deployments; default 4663-beta.json, fork mode fork.json).
contract MainnetBeta is Script {
    // ---- real Robinhood Chain mainnet contracts (chain facts, verified 2026-10-04)
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address public constant REGISTRY_6538 = 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538;
    address public constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    uint256 public constant MAINNET_CHAIN_ID = 4663;
    uint256 public constant FORK_CHAIN_ID = 31337;

    // ---- mainnet timers
    uint64 public constant CROWD_WINDOW = 1 days;
    uint64 public constant BEACON_GRACE = 1 hours;
    uint64 public constant TIMELOCK = 48 hours; // treasury policy, Hidden Vault caps, park adapters
    uint256 public constant UNBONDING = 7 days;
    uint256 public constant INSURANCE_DELAY = 14 days;
    uint256 public constant PERP_COOLDOWN = 24 hours;

    // ---- oracle staleness: Chainlink's heartbeat is 24 h on these feeds and weekday gaps up to ~22 h were seen
    // (chain facts); 26 h keeps weekdays live and puts weekends / holidays on hold (risk-reducing actions only).
    uint256 public constant DEFAULT_MAX_STALENESS = 26 hours;
    uint256 public constant MIN_STALENESS = 1 hours;
    uint256 public constant MAX_STALENESS_LIMIT = 7 days;
    uint256 public constant FORK_DEFAULT_STALENESS = 7 days;

    // ---- caps: none (Kal 2026-10-08)
    uint256 public constant UNLIMITED = type(uint256).max;
    uint256 public constant PERP_OI_CAP_BPS = 10_000; // the most PerpMarket.setParams accepts
    uint256 public constant HIDDEN_MIN_DEPOSIT = 1e6; // 1 USDG: no dust notes (not a cap)

    uint16 public constant CROWD_SLIPPAGE_BPS = 100;
    uint256 public constant DEFAULT_MIN_CROWD = 3;
    uint256 public constant PLTH_USDG_PER_SIDE = 50_000e6;
    uint256 public constant PLTH_PRICE = 0.05e18;
    uint256 public constant TOKEN_USDG_NEEDED = PLTH_USDG_PER_SIDE * 101 / 100;
    /// FeeRouter buyback slice per push. Not a user cap: a push spends at most this on PLTH and carries the rest;
    /// an unlimited slice would make every buy fail the router's own slippage check once fees pile up.
    uint256 public constant BUYBACK_PER_PUSH = 200e6;

    struct Stock {
        string sym;
        address token;
        address feed;
        uint24 fee;
        int24 tickSpacing;
    }

    struct Config {
        bool fork;
        bool deployToken;
        address owner;
        address keeper;
        address attester;
        address relayer;
        address controller;
        address cashDesk;
        address equityDesk;
        uint32 minCrowd;
        uint256 maxStaleness;
        string out;
    }

    error WrongChain(uint256 chainId, uint256 required);
    error MissingCode(address what);
    error ZeroRole(string role);
    error DuplicateRole(string a, string b);
    error BadStaleness(uint256 value);
    error BadMinCrowd(uint256 value);
    error NotEnoughUsdg(uint256 have, uint256 need);
    error HandoffIncomplete(address target, string what);

    // Outputs (script storage: keeps every function's stack small).
    Config cfg;
    address deployer;
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
    address policyImpl;
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

    // ---------------------------------------------------------------- checks (public: tests call them)

    /// Mainnet mode runs only on 4663; fork mode only on 31337.
    function checkChain(bool fork, uint256 chainId) public pure {
        uint256 need = fork ? FORK_CHAIN_ID : MAINNET_CHAIN_ID;
        if (chainId != need) revert WrongChain(chainId, need);
    }

    /// Every role set, all distinct from each other and from the deployer; staleness and crowd size in range.
    function checkConfig(Config memory c, address deployer_) public pure {
        address[8] memory a =
            [c.owner, c.keeper, c.attester, c.relayer, c.controller, c.cashDesk, c.equityDesk, deployer_];
        string[8] memory n =
            ["OWNER", "KEEPER", "ATTESTER", "RELAYER", "CONTROLLER", "CASH_DESK", "EQUITY_DESK", "deployer"];
        for (uint256 i; i < a.length; ++i) {
            if (a[i] == address(0)) revert ZeroRole(n[i]);
            for (uint256 j; j < i; ++j) {
                if (a[i] == a[j]) revert DuplicateRole(n[j], n[i]);
            }
        }
        if (c.maxStaleness < MIN_STALENESS || c.maxStaleness > MAX_STALENESS_LIMIT) revert BadStaleness(c.maxStaleness);
        if (c.minCrowd == 0) revert BadMinCrowd(c.minCrowd);
    }

    /// Reads the configuration from the environment. Roles have no defaults.
    function loadConfig() public view returns (Config memory c) {
        c.fork = vm.envOr("BETA_FORK", false);
        c.deployToken = vm.envOr("DEPLOY_TOKEN", false);
        c.owner = vm.envAddress("OWNER");
        c.keeper = vm.envAddress("KEEPER");
        c.attester = vm.envAddress("ATTESTER");
        c.relayer = vm.envAddress("RELAYER");
        c.controller = vm.envAddress("CONTROLLER");
        c.cashDesk = vm.envAddress("CASH_DESK");
        c.equityDesk = vm.envAddress("EQUITY_DESK");
        uint256 mc = vm.envOr("MIN_CROWD", DEFAULT_MIN_CROWD);
        if (mc == 0 || mc > type(uint32).max) revert BadMinCrowd(mc);
        c.minCrowd = uint32(mc);
        c.maxStaleness = c.fork
            ? vm.envOr("FORK_MAX_STALENESS", FORK_DEFAULT_STALENESS)
            : vm.envOr("MAX_STALENESS", DEFAULT_MAX_STALENESS);
        c.out = vm.envOr("BETA_OUT", c.fork ? string("fork.json") : string("4663-beta.json"));
        checkOutName(c.out);
    }

    error BadOutName(string name);

    /// The output is a plain file name inside app/deployments: letters, digits, '.', '-', '_'; no path, no "..".
    function checkOutName(string memory name) public pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 64 || b[0] == ".") revert BadOutName(name);
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == "."
                || ch == "-" || ch == "_";
            if (!ok) revert BadOutName(name);
        }
    }

    // ---------------------------------------------------------------- run

    function run() external {
        deploy(loadConfig());
    }

    /// The whole deploy for one configuration (run() reads it from the environment).
    function deploy(Config memory c) public {
        checkChain(c.fork, block.chainid);
        checkOutName(c.out);
        address[7] memory real = [USDG, POOL_MANAGER, PERMIT2, ANNOUNCER, REGISTRY_6538, STEAK_USDG, MULTICALL3];
        for (uint256 i; i < real.length; ++i) {
            if (real[i].code.length == 0) revert MissingCode(real[i]);
        }
        Stock[] memory s = stocks();
        for (uint256 i; i < s.length; ++i) {
            if (s[i].token.code.length == 0) revert MissingCode(s[i].token);
            if (s[i].feed.code.length == 0) revert MissingCode(s[i].feed);
        }
        cfg = c;
        startBlock = vm.getBlockNumber();

        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        checkConfig(c, deployer);
        if (c.deployToken) {
            uint256 bal = IERC20(USDG).balanceOf(deployer);
            if (bal < TOKEN_USDG_NEEDED) revert NotEnoughUsdg(bal, TOKEN_USDG_NEEDED);
        }
        _core();
        if (c.deployToken) _token();
        _treasury();
        _consumer();
        _hidden();
        _perps();
        _handOff();
        vm.stopBroadcast();
        checkHandoff();
        _write();
    }

    function _core() private {
        registry = new StockTokenRegistry(deployer);
        valuer = new Valuer(registry, cfg.maxStaleness);
        router = new StockRouter(IPoolManager(POOL_MANAGER), registry, valuer, IERC20Metadata(USDG), deployer);
        Stock[] memory s = stocks();
        for (uint256 i; i < s.length; ++i) {
            registry.list(s[i].token, s[i].feed, true);
            router.setPool(s[i].token, poolKeyOf(s[i]));
        }
        eligibility = new EligibilityRegistry(cfg.owner, cfg.attester);
    }

    function _token() private {
        // 80% (worker) to the deployer only to seed the PLTH/USDG pool; the rest goes to OWNER in _handOff.
        plth = new PLTH(deployer, cfg.owner, cfg.owner);
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(USDG), _tiers(), UNBONDING);
        insurance = new ExceptionInsurancePool(IERC20Metadata(USDG), cfg.owner, INSURANCE_DELAY);
        TestnetPoolSeeder seeder = new TestnetPoolSeeder(IPoolManager(POOL_MANAGER));
        bool usdgIs0 = USDG < address(plth);
        plthKey = usdgIs0
            ? PoolKey(USDG, address(plth), 3000, 60, IHooks(address(0)))
            : PoolKey(address(plth), USDG, 3000, 60, IHooks(address(0)));
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(PLTH_PRICE, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, PLTH_USDG_PER_SIDE, usdgIs0);
        uint256 plthNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);
        IERC20(USDG).transfer(address(seeder), TOKEN_USDG_NEEDED);
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
            BUYBACK_PER_PUSH,
            deployer
        );
        insurance.bindFeeRouter(address(feeRouter));
        feeRouter.setKeeper(cfg.keeper); // push and observe are keeper-only
    }

    /// Same four tiers as the fork and the testnet: 0 / 10k / 100k / 1M PLTH.
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
        policyImpl = address(new TreasuryPolicy(address(0), none, TIMELOCK));
        address accountImpl =
            address(new TreasuryAccount(address(0), TreasuryPolicy(address(0)), PolicyGuard(address(0)), address(0)));
        address closeImpl = address(
            new PeriodClose(
                TreasuryAccount(payable(address(0))), IERC20Metadata(address(0)), address(0), ITierSource(address(0))
            )
        );
        address approvalsImpl = address(new BoardApprovals(address(0), address(0)));
        ITierSource tiers = cfg.deployToken ? ITierSource(address(staking)) : ITierSource(address(0));
        templates = new TemplateRegistry(cfg.owner, tiers);
        receipts = new Receipts();
        // Platform close fees: the FeeRouter (stakers, insurance, buyback, template authors) with the token, else OWNER.
        address feeTo = cfg.deployToken ? address(feeRouter) : cfg.owner;
        factory = new TreasuryFactory(
            policyImpl, accountImpl, closeImpl, approvalsImpl, guard, IERC20Metadata(USDG), feeTo, tiers, templates
        );
        if (cfg.deployToken) feeRouter.setTemplateFees(ITemplateFeeSource(address(factory)), 2000);
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
        beacon = new JitterBeacon(cfg.keeper, cfg.owner, BEACON_GRACE);
        vault = new SavingsVault(IERC20(USDG), PERMIT2, ICanonicalRegistry(address(registry)), deployer, cfg.keeper);
        vault.setEligibility(IEligibility(address(eligibility)));
        genesis = uint64(block.timestamp - (block.timestamp % 1 days));
        crowd = new CrowdBuy(
            vault,
            router,
            IExecuteBeacon(address(beacon)),
            cfg.minCrowd,
            CROWD_SLIPPAGE_BPS,
            genesis,
            deployer,
            cfg.keeper,
            CROWD_WINDOW
        );
        vault.setCrowd(address(crowd));
        stealthClaims =
            new StealthClaims(address(crowd), IERC5564Announcer(ANNOUNCER), IERC6538Registry(REGISTRY_6538));
        crowd.setStealthClaims(stealthClaims);
    }

    function _hidden() private {
        shieldedPool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), deployer, TIMELOCK
        );
        shieldedPool.setCrowd(address(crowd));
        shieldedTrade = new ShieldedTrade(
            shieldedPool,
            IHonkVerifier(address(new SwapVerifier())),
            IHonkVerifier(address(new SettleVerifier())),
            router,
            deployer,
            TIMELOCK
        );
        shieldedPool.setTrade(address(shieldedTrade));
        crowd.setShieldedPool(IShieldedDeposit(address(shieldedPool)));
        parkAdapter = new ERC4626Park(IERC4626(STEAK_USDG), USDG);
        shieldedTrade.proposeAdapter(IParkAdapter(address(parkAdapter)));
        shieldedPool.setMinDeposit(USDG, HIDDEN_MIN_DEPOSIT);
        address[] memory assets = hiddenAssets();
        for (uint256 i; i < assets.length; ++i) {
            shieldedPool.proposeCap(assets[i], UNLIMITED);
        }
        thresholdVerifier = new ThresholdVerifier(
            shieldedPool,
            IHonkVerifier(address(new ThresholdHoldingsVerifier())),
            IHonkVerifier(address(new ThresholdSavingsVerifier()))
        );
    }

    /// Every asset the Hidden Vault holds: USDG, steakUSDG shares (park) and the nine Stock Tokens.
    function hiddenAssets() public pure returns (address[] memory a) {
        Stock[] memory s = stocks();
        a = new address[](s.length + 2);
        a[0] = USDG;
        a[1] = STEAK_USDG;
        for (uint256 i; i < s.length; ++i) {
            a[i + 2] = s[i].token;
        }
    }

    /// In-house perp venue: one PerpPool over real USDG and a market for each of the four deepest names, priced
    /// by the same Valuer. No LP seed: liquidity is OWNER's call after the deploy.
    function _perps() private {
        perpPool = new PerpPool(IERC20(USDG), deployer, PERP_COOLDOWN);
        Stock[] memory s = stocks();
        uint256[4] memory pick = [uint256(0), 1, 2, 8]; // TSLA, AAPL, NVDA, SPY
        for (uint256 i; i < pick.length; ++i) {
            PerpMarket m = new PerpMarket(perpPool, valuer, s[pick[i]].token, deployer);
            m.setParams(
                m.takerFeeBps(),
                m.makerFeeBps(),
                m.offHoursSpreadBps(),
                m.borrowBpsPerHour(),
                m.fundingK(),
                PERP_OI_CAP_BPS,
                m.maxProfitBps(),
                m.liquidationFee()
            );
            perpPool.addMarket(address(m));
            perpMarkets.push(address(m));
            perpSymbols.push(s[pick[i]].sym);
        }
    }

    /// Hands every admin role to OWNER. One-step contracts are OWNER's now; two-step ones wait for OWNER's accept.
    function _handOff() private {
        address o = cfg.owner;
        registry.transferOwnership(o);
        router.transferOwnership(o);
        vault.transferOwnership(o);
        crowd.transferOwnership(o);
        shieldedPool.transferOwnership(o);
        shieldedTrade.transferOwnership(o);
        perpPool.transferOwnership(o);
        for (uint256 i; i < perpMarkets.length; ++i) {
            PerpMarket(perpMarkets[i]).transferOwnership(o);
        }
        if (cfg.deployToken) {
            feeRouter.transferOwnership(o);
            uint256 left = plth.balanceOf(deployer);
            if (left != 0) IERC20(address(plth)).transfer(o, left);
        }
    }

    /// Contracts OWNER must call acceptOwnership() on after the deploy.
    function pendingAccepts() public view returns (address[] memory a) {
        a = new address[](6 + perpMarkets.length);
        a[0] = address(registry);
        a[1] = address(vault);
        a[2] = address(crowd);
        a[3] = address(shieldedPool);
        a[4] = address(shieldedTrade);
        a[5] = address(perpPool);
        for (uint256 i; i < perpMarkets.length; ++i) {
            a[6 + i] = perpMarkets[i];
        }
    }

    /// Fails the run (and so the simulation, before any broadcast) unless OWNER holds or is pending on every admin
    /// role, the bots sit where they should, the caps are unlimited and the timers are the mainnet ones.
    function checkHandoff() public view {
        address o = cfg.owner;
        _is(IOwned(address(router)).owner() == o, address(router), "router owner");
        _is(IOwned(address(eligibility)).owner() == o, address(eligibility), "eligibility owner");
        _is(eligibility.attester() == cfg.attester, address(eligibility), "attester");
        _is(IOwned(address(beacon)).owner() == o, address(beacon), "beacon owner");
        _is(beacon.keeper() == cfg.keeper && beacon.GRACE() == BEACON_GRACE, address(beacon), "beacon keeper/GRACE");
        address[] memory p = pendingAccepts();
        for (uint256 i; i < p.length; ++i) {
            _is(IPendingOwned(p[i]).pendingOwner() == o, p[i], "pendingOwner");
            _is(IOwned(p[i]).owner() == deployer, p[i], "owner until accepted");
        }
        _is(vault.keeper() == cfg.keeper && crowd.keeper() == cfg.keeper, address(crowd), "keeper");
        _is(crowd.WINDOW() == CROWD_WINDOW, address(crowd), "WINDOW");
        _is(shieldedPool.CAP_DELAY() == TIMELOCK, address(shieldedPool), "CAP_DELAY");
        _is(shieldedTrade.ADAPTER_DELAY() == TIMELOCK, address(shieldedTrade), "ADAPTER_DELAY");
        _is(TreasuryPolicy(policyImpl).TIMELOCK() == TIMELOCK, policyImpl, "policy TIMELOCK");
        _is(perpPool.REDEEM_COOLDOWN() == PERP_COOLDOWN, address(perpPool), "REDEEM_COOLDOWN");
        _is(templates.committee() == o, address(templates), "template committee");
        address[] memory assets = hiddenAssets();
        for (uint256 i; i < assets.length; ++i) {
            (uint256 cap,) = shieldedPool.capProposal(assets[i]);
            _is(cap == UNLIMITED, assets[i], "Hidden Vault cap proposal");
        }
        for (uint256 i; i < perpMarkets.length; ++i) {
            _is(PerpMarket(perpMarkets[i]).oiCapBps() == PERP_OI_CAP_BPS, perpMarkets[i], "oiCapBps");
        }
        if (cfg.deployToken) {
            _is(IOwned(address(feeRouter)).owner() == o, address(feeRouter), "feeRouter owner");
            _is(insurance.committee() == o, address(insurance), "insurance committee");
            _is(staking.UNBONDING() == UNBONDING, address(staking), "UNBONDING");
            _is(insurance.WITHDRAW_DELAY() == INSURANCE_DELAY, address(insurance), "WITHDRAW_DELAY");
            _is(plth.balanceOf(deployer) == 0, address(plth), "deployer PLTH");
        }
    }

    function _is(bool ok, address target, string memory what) private pure {
        if (!ok) revert HandoffIncomplete(target, what);
    }

    function _write() private {
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
            stocksJson = vm.serializeString("stocks", s[i].sym, one);
        }
        string memory perpJson;
        for (uint256 i; i < perpMarkets.length; ++i) {
            perpJson = vm.serializeAddress("perpMarkets", perpSymbols[i], perpMarkets[i]);
        }

        string memory r = "beta";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", startBlock + 1);
        vm.serializeBool(r, "fork", cfg.fork);
        vm.serializeBool(r, "beta", true);
        vm.serializeBool(r, "mockFeeds", false);
        vm.serializeBool(r, "deployToken", cfg.deployToken);
        vm.serializeAddress(r, "deployer", deployer);
        vm.serializeAddress(r, "owner", cfg.owner);
        vm.serializeAddress(r, "keeper", cfg.keeper);
        vm.serializeAddress(r, "attester", cfg.attester);
        vm.serializeAddress(r, "relayer", cfg.relayer);
        vm.serializeAddress(r, "controller", cfg.controller);
        vm.serializeAddress(r, "cashDesk", cfg.cashDesk);
        vm.serializeAddress(r, "equityDesk", cfg.equityDesk);
        vm.serializeAddress(r, "committee", cfg.owner);
        vm.serializeAddress(r, "acceptOwnership", pendingAccepts());
        vm.serializeUint(r, "maxStaleness", cfg.maxStaleness);
        vm.serializeUint(r, "minCrowd", cfg.minCrowd);
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
        if (cfg.deployToken) {
            vm.serializeAddress(r, "plth", address(plth));
            vm.serializeAddress(r, "staking", address(staking));
            vm.serializeAddress(r, "insurancePool", address(insurance));
            vm.serializeAddress(r, "feeRouter", address(feeRouter));
            vm.serializeBytes32(r, "plthPoolId", plthPoolId);
        }
        vm.serializeUint(r, "genesis", genesis);
        string memory json = vm.serializeString(r, "stocks", stocksJson);
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../app/deployments/", cfg.out));
    }
}
