// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {TreasuryFactory} from "../../src/treasury/TreasuryFactory.sol";
import {TemplateRegistry} from "../../src/treasury/TemplateRegistry.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {FeeRouter} from "../../src/token/FeeRouter.sol";
import {PLTH} from "../../src/token/PLTH.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {Permit2Code} from "../consumer/Permit2Code.sol";
import {StealthCode} from "../consumer/StealthCode.sol";
import {SafeCode} from "../mocks/SafeCode.sol";

interface IOwned2 {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
}

/// MainnetBeta.s.sol rules, offline: the real 4663 addresses get stand-ins (mock USDG, mock Stock Tokens and
/// feeds at the real token/feed addresses, the real v4 PoolManager / Permit2 / ERC-5564 / ERC-6538 runtimes, a
/// mock ERC-4626 at steakUSDG), then the script runs exactly as `forge script` would.
contract MainnetBetaTest is Test {
    MainnetBeta script;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address attester = makeAddr("attester");
    address relayer = makeAddr("relayer");
    address controller = makeAddr("controller");
    address cashDesk = makeAddr("cashDesk");
    address equityDesk = makeAddr("equityDesk");
    address saver = makeAddr("saver");

    function setUp() public {
        vm.warp(1_800_000_000);
        script = new MainnetBeta();
        // Mainnet mode wants OWNER to be a Safe with threshold >= 2 (review v2 L-22, v4 R4-ORC-1).
        address[] memory safeOwners = new address[](3);
        (safeOwners[0], safeOwners[1], safeOwners[2]) = (makeAddr("signer1"), makeAddr("signer2"), makeAddr("signer3"));
        // A real-looking Safe (review v5 R5-ORC-1): the official SafeProxy runtime at OWNER, pointing at the official
        // v1.3.0 singleton address (a Safe-storage-layout stand-in there, since tests run offline).
        deployCodeTo("SafeCode.sol:MockSafeSingleton", SafeCode.SINGLETON_130);
        _makeSafe(owner, safeOwners, 2);
        deployCodeTo("MockUSDG.sol:MockUSDG", script.USDG());
        MainnetBeta.Stock[] memory s = script.stocks();
        for (uint256 i; i < s.length; ++i) {
            deployCodeTo("MockStockToken.sol:MockStockToken", abi.encode(s[i].sym, s[i].sym), s[i].token);
            deployCodeTo("MockFeed.sol:MockFeed", abi.encode(uint8(8), int256(100e8 + int256(i) * 10e8), s[i].sym), s[i].feed);
        }
        vm.etch(
            script.POOL_MANAGER(),
            vm.parseBytes(string.concat("0x", vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/v4_pool_manager.runtime.hex"))))
        );
        vm.etch(Permit2Code.PERMIT2, Permit2Code.RUNTIME);
        vm.etch(StealthCode.ANNOUNCER, StealthCode.ANNOUNCER_RUNTIME);
        vm.etch(StealthCode.REGISTRY, StealthCode.REGISTRY_RUNTIME);
        deployCodeTo("Multicall3Lite.sol:Multicall3Lite", script.MULTICALL3());
        deployCodeTo("MockUsdgVault.sol:MockUsdgVault", abi.encode(script.USDG()), script.STEAK_USDG());

        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("ATTESTER", vm.toString(attester));
        vm.setEnv("RELAYER", vm.toString(relayer));
        vm.setEnv("CONTROLLER", vm.toString(controller));
        vm.setEnv("CASH_DESK", vm.toString(cashDesk));
        vm.setEnv("EQUITY_DESK", vm.toString(equityDesk));
        vm.setEnv("BETA_OUT", "test-beta-env.json");
        vm.setEnv("BETA_FORK", "false");
        vm.setEnv("DEPLOY_TOKEN", "false");
        vm.setEnv("MIN_CROWD", "3");
        vm.setEnv("MAX_STALENESS", vm.toString(script.DEFAULT_MAX_STALENESS()));
        vm.setEnv("FORK_MAX_STALENESS", vm.toString(uint256(7 days)));
    }

    /// Turns `at` into a Safe the OWNER pin accepts: official SafeProxy runtime, official singleton in slot 0, the
    /// owners linked list (slot 2), owner count (3), threshold (4) and an empty module list (slot 1).
    function _makeSafe(address at, address[] memory signers, uint256 threshold) internal {
        vm.etch(at, SafeCode.PROXY_130_RUNTIME);
        vm.store(at, bytes32(0), bytes32(uint256(uint160(SafeCode.SINGLETON_130))));
        address sentinel = address(1);
        address prev = sentinel;
        for (uint256 i; i < signers.length; i++) {
            vm.store(at, keccak256(abi.encode(prev, uint256(2))), bytes32(uint256(uint160(signers[i]))));
            prev = signers[i];
        }
        vm.store(at, keccak256(abi.encode(prev, uint256(2))), bytes32(uint256(uint160(sentinel))));
        vm.store(at, bytes32(uint256(3)), bytes32(signers.length));
        vm.store(at, bytes32(uint256(4)), bytes32(threshold));
        vm.store(at, keccak256(abi.encode(sentinel, uint256(1))), bytes32(uint256(uint160(sentinel))));
    }

    /// Suites that inherit these tests run in parallel with this one: the test contract's code hash keeps their
    /// output files apart.
    function _suiteTag() internal view returns (string memory) {
        return string.concat("-", vm.toString(uint256(uint32(uint256(address(this).codehash)))));
    }

    /// One output file per test (tests run in parallel): named after the running test's selector.
    function _out() internal view returns (string memory) {
        return string.concat("test-beta-", vm.toString(uint256(uint32(msg.sig))), _suiteTag(), ".json");
    }

    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../app/deployments/", _out());
    }

    function _deploy() internal returns (string memory json) {
        json = _deployWith(_cfg());
    }

    function _deployWith(MainnetBeta.Config memory c) internal returns (string memory json) {
        c.out = _out();
        script.deploy(c);
        json = vm.readFile(_path());
        vm.removeFile(_path());
    }

    function _a(string memory json, string memory key) internal pure returns (address) {
        return vm.parseJsonAddress(json, string.concat(".", key));
    }

    function _mainnetDeploy() internal returns (string memory) {
        vm.chainId(4663);
        return _deploy();
    }

    function _acceptAll(string memory json) internal {
        address[] memory p = vm.parseJsonAddressArray(json, ".acceptOwnership");
        for (uint256 i; i < p.length; ++i) {
            vm.prank(owner);
            IOwned2(p[i]).acceptOwnership();
        }
    }

    // ---------------------------------------------------------------- chain guard

    function test_mainnetModeRefusesEveryOtherChain() public {
        uint256[4] memory ids = [uint256(1), 31337, 46630, 42161];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(MainnetBeta.WrongChain.selector, ids[i], 4663));
            script.deploy(_cfg());
        }
    }

    function test_forkModeRefusesMainnetAndTestnet() public {
        MainnetBeta.Config memory c = _cfg();
        c.fork = true;
        uint256[2] memory ids = [uint256(4663), 46630];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(MainnetBeta.WrongChain.selector, ids[i], 31337));
            script.deploy(c);
        }
    }

    function testFuzz_checkChain(bool fork, uint256 chainId) public view {
        uint256 need = fork ? 31337 : 4663;
        if (chainId == need) {
            script.checkChain(fork, chainId);
        } else {
            try script.checkChain(fork, chainId) {
                revert("accepted a wrong chain");
            } catch {}
        }
    }

    // ---------------------------------------------------------------- configuration

    /// run() reads every role from the environment (no defaults); this suite's env names them all.
    function test_loadConfigReadsTheEnvironment() public view {
        MainnetBeta.Config memory c = script.loadConfig();
        assertEq(c.owner, owner);
        assertEq(c.keeper, keeper);
        assertEq(c.attester, attester);
        assertEq(c.relayer, relayer);
        assertEq(c.controller, controller);
        assertEq(c.cashDesk, cashDesk);
        assertEq(c.equityDesk, equityDesk);
        assertFalse(c.fork);
        assertFalse(c.deployToken);
        assertEq(c.maxStaleness, 26 hours);
        assertEq(c.minCrowd, 3);
    }

    function test_ownerIsRequired() public {
        MainnetBeta.Config memory c = _cfg();
        c.owner = address(0);
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.ZeroRole.selector, "OWNER"));
        script.deploy(c);
    }

    function _cfg() internal view returns (MainnetBeta.Config memory c) {
        c.owner = owner;
        c.keeper = keeper;
        c.attester = attester;
        c.relayer = relayer;
        c.controller = controller;
        c.cashDesk = cashDesk;
        c.equityDesk = equityDesk;
        c.minCrowd = 3;
        c.maxStaleness = 26 hours;
        c.out = "test-beta.json";
    }

    function test_configAcceptsDistinctRoles() public {
        script.checkConfig(_cfg(), makeAddr("deployer"));
    }

    function test_ownerCannotBeTheDeployer() public {
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.DuplicateRole.selector, "OWNER", "deployer"));
        script.checkConfig(_cfg(), owner);
    }

    function test_botCannotBeTheOwner() public {
        MainnetBeta.Config memory c = _cfg();
        c.keeper = owner;
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.DuplicateRole.selector, "OWNER", "KEEPER"));
        script.checkConfig(c, makeAddr("deployer"));
    }

    function test_zeroRoleRefused() public {
        MainnetBeta.Config memory c = _cfg();
        c.relayer = address(0);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.ZeroRole.selector, "RELAYER"));
        script.checkConfig(c, makeAddr("deployer"));
    }

    /// Any two of the eight roles equal -> refused.
    function testFuzz_duplicateRolesRefused(uint8 i, uint8 j) public {
        i = uint8(bound(i, 0, 7));
        j = uint8(bound(j, 0, 7));
        vm.assume(i != j);
        address[8] memory a = [owner, keeper, attester, relayer, controller, cashDesk, equityDesk, makeAddr("deployer")];
        a[i] = a[j];
        MainnetBeta.Config memory c = _cfg();
        (c.owner, c.keeper, c.attester, c.relayer, c.controller, c.cashDesk, c.equityDesk) =
            (a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
        vm.expectRevert();
        script.checkConfig(c, a[7]);
    }

    /// Mainnet mode: 1 h .. 26 h (review v2 L-24 pins the mainnet default as the maximum); fork mode: 1 h .. 7 d.
    function testFuzz_stalenessBounds(uint256 s, bool fork) public {
        MainnetBeta.Config memory c = _cfg();
        c.fork = fork;
        c.maxStaleness = s;
        if (s < 1 hours || s > (fork ? 7 days : 26 hours)) {
            vm.expectRevert(abi.encodeWithSelector(MainnetBeta.BadStaleness.selector, s));
        }
        script.checkConfig(c, makeAddr("deployer"));
    }

    function test_outputMustBeAPlainFileName() public {
        script.checkOutName("4663-beta.json");
        string[4] memory bad = ["../x.json", "a/b.json", ".hidden", ""];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MainnetBeta.BadOutName.selector, bad[i]));
            script.checkOutName(bad[i]);
        }
    }

    function test_missingRealContractRefused() public {
        vm.chainId(4663);
        vm.etch(script.STEAK_USDG(), "");
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.MissingCode.selector, script.STEAK_USDG()));
        script.deploy(_cfg());
    }

    // ---------------------------------------------------------------- the deploy (token off: the beta default)

    function test_deployHandsEveryAdminRoleToOwner() public {
        string memory json = _mainnetDeploy();
        address dep = _a(json, "deployer");
        assertTrue(dep != owner);
        assertEq(Ownable(_a(json, "stockRouter")).owner(), owner);
        assertEq(Ownable(_a(json, "eligibilityRegistry")).owner(), owner);
        assertEq(Ownable(_a(json, "jitterBeacon")).owner(), owner);
        assertEq(TemplateRegistry(_a(json, "templateRegistry")).committee(), owner);
        address[] memory p = vm.parseJsonAddressArray(json, ".acceptOwnership");
        assertEq(p.length, 12); // registry, vault, crowd, pool, trade, perp pool, valuer, treasury factory + 4 markets
        for (uint256 i; i < p.length; ++i) {
            assertEq(IOwned2(p[i]).pendingOwner(), owner);
            assertEq(IOwned2(p[i]).owner(), dep);
        }
        _acceptAll(json);
        for (uint256 i; i < p.length; ++i) {
            assertEq(IOwned2(p[i]).owner(), owner);
            assertEq(IOwned2(p[i]).pendingOwner(), address(0));
        }
        // The post-deploy check passes after OWNER's accepts too.
        MainnetBeta v = new MainnetBeta();
        string memory f = string.concat("verify-", vm.toString(uint256(uint32(msg.sig))), _suiteTag(), ".json");
        vm.writeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f), json);
        v.verifyDeployment(f);
        vm.removeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f));
        // The deployer keeps nothing: its admin calls now revert.
        ShieldedPool pool = ShieldedPool(_a(json, "shieldedPool"));
        vm.prank(dep);
        vm.expectRevert();
        pool.setDepositsPaused(true);
        StockTokenRegistry reg = StockTokenRegistry(_a(json, "stockTokenRegistry"));
        address tsla = script.stocks()[0].token;
        vm.prank(dep);
        vm.expectRevert(StockTokenRegistry.NotOwner.selector);
        reg.delist(tsla);
        // The adapter allow-list holds the shipped sleeves, and later additions are OWNER's, behind 48 h.
        TreasuryFactory fac = TreasuryFactory(_a(json, "treasuryFactory"));
        assertTrue(fac.adapterAllowed(_a(json, "cashSleeve").codehash));
        assertTrue(fac.adapterAllowed(_a(json, "equitySleeve").codehash));
        vm.prank(dep);
        vm.expectRevert(TreasuryFactory.NotOwner.selector);
        fac.setAdapterAllowed(keccak256("x"), true);
        vm.prank(owner);
        fac.setAdapterAllowed(keccak256("x"), true); // queued, not applied
        assertFalse(fac.adapterAllowed(keccak256("x")));
    }

    /// review5 Info: an entry the deployer adds during first-time setup (instantly, before OWNER accepts) is listed
    /// and fails the post-deploy check.
    function test_verifyDeploymentFailsOnAnExtraAllowListEntry() public {
        string memory json = _mainnetDeploy();
        TreasuryFactory fac = TreasuryFactory(_a(json, "treasuryFactory"));
        vm.prank(_a(json, "deployer"));
        fac.setAdapterAllowed(keccak256("the deployer's own adapter"), true); // still first-time setup: instant
        assertEq(fac.allowedHashes().length, 3);
        MainnetBeta v = new MainnetBeta();
        string memory f = string.concat("verify-", vm.toString(uint256(uint32(msg.sig))), ".json");
        vm.writeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f), json);
        vm.expectRevert(
            abi.encodeWithSelector(MainnetBeta.HandoffIncomplete.selector, address(fac), "allow-list: exactly the shipped sleeves")
        );
        v.verifyDeployment(f);
        vm.removeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f));
    }

    function test_verifyDeploymentFailsWithoutTheAllowList() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        TreasuryFactory fac = TreasuryFactory(_a(json, "treasuryFactory"));
        vm.prank(owner);
        fac.setAdapterAllowed(_a(json, "cashSleeve").codehash, false); // removal applies at once
        MainnetBeta v = new MainnetBeta();
        string memory f = string.concat("verify-", vm.toString(uint256(uint32(msg.sig))), _suiteTag(), ".json");
        vm.writeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f), json);
        vm.expectRevert(
            abi.encodeWithSelector(MainnetBeta.HandoffIncomplete.selector, address(fac), "allow-list: cashSleeve")
        );
        v.verifyDeployment(f);
        vm.removeFile(string.concat(vm.projectRoot(), "/../app/deployments/", f));
    }

    function test_botsSitWhereTheyShould() public {
        string memory json = _mainnetDeploy();
        assertEq(CrowdBuy(_a(json, "crowdBuy")).keeper(), keeper);
        assertEq(SavingsVault(_a(json, "savingsVault")).keeper(), keeper);
        assertEq(JitterBeacon(_a(json, "jitterBeacon")).keeper(), keeper);
        assertEq(EligibilityRegistry(_a(json, "eligibilityRegistry")).attester(), attester);
        assertEq(_a(json, "relayer"), relayer);
        assertEq(_a(json, "controller"), controller);
        assertEq(_a(json, "cashDesk"), cashDesk);
        assertEq(_a(json, "equityDesk"), equityDesk);
        assertEq(_a(json, "owner"), owner);
    }

    function test_mainnetTimers() public {
        string memory json = _mainnetDeploy();
        assertEq(CrowdBuy(_a(json, "crowdBuy")).WINDOW(), 1 days);
        assertEq(JitterBeacon(_a(json, "jitterBeacon")).GRACE(), 1 hours);
        assertEq(ShieldedPool(_a(json, "shieldedPool")).CAP_DELAY(), 48 hours);
        assertEq(ShieldedTrade(_a(json, "shieldedTrade")).ADAPTER_DELAY(), 48 hours);
        assertEq(PerpPool(_a(json, "perpPool")).REDEEM_COOLDOWN(), 24 hours);
        assertEq(Valuer(_a(json, "valuer")).maxStaleness(), 26 hours);
        assertEq(CrowdBuy(_a(json, "crowdBuy")).MIN_CROWD(), 3);
    }

    /// No caps: every Hidden Vault asset is proposed at uint256 max and applies after the 48h timelock; a deposit
    /// far above the old 1M fork cap goes through.
    function test_capsUnlimitedAfterTheTimelock() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        ShieldedPool pool = ShieldedPool(_a(json, "shieldedPool"));
        address[] memory assets = script.hiddenAssets();
        for (uint256 i; i < assets.length; ++i) {
            (uint256 c, uint64 eta) = pool.capProposal(assets[i]);
            assertEq(c, type(uint256).max);
            assertEq(eta, block.timestamp + 48 hours);
            vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TooEarly.selector, eta));
            pool.applyCap(assets[i]);
        }
        vm.warp(block.timestamp + 48 hours);
        for (uint256 i; i < assets.length; ++i) {
            pool.applyCap(assets[i]);
            assertEq(pool.cap(assets[i]), type(uint256).max);
        }
        uint256 big = 50_000_000e6; // 50M USDG
        _depositHidden(pool, big);
        assertEq(pool.shielded(script.USDG()), big);
    }

    function _depositHidden(ShieldedPool pool, uint256 raw) internal {
        MockUSDG(script.USDG()).mint(saver, raw);
        vm.startPrank(saver);
        IERC20(script.USDG()).approve(address(pool), raw);
        pool.deposit(script.USDG(), raw, bytes32(uint256(7)), bytes32(uint256(11)), hex"01");
        vm.stopPrank();
    }

    /// Emergency levers stay with the owner: pause/unpause deposits, lower a cap at once.
    function test_ownerCanPauseAndLowerACap() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        ShieldedPool pool = ShieldedPool(_a(json, "shieldedPool"));
        address usdg = script.USDG();
        vm.warp(block.timestamp + 48 hours);
        pool.applyCap(usdg);
        _depositHidden(pool, 2_000_000e6);

        vm.prank(keeper);
        vm.expectRevert();
        pool.setDepositsPaused(true);
        vm.prank(owner);
        pool.setDepositsPaused(true);
        MockUSDG(usdg).mint(saver, 1e6);
        vm.startPrank(saver);
        IERC20(usdg).approve(address(pool), 1e6);
        vm.expectRevert(ShieldedPool.Paused.selector);
        pool.deposit(usdg, 1e6, bytes32(uint256(7)), bytes32(uint256(11)), hex"01");
        vm.stopPrank();
        vm.prank(owner);
        pool.setDepositsPaused(false);
        _depositHidden(pool, 1e6);

        uint256 held = pool.shielded(usdg);
        vm.prank(owner);
        pool.proposeCap(usdg, held); // lower: applies at once
        assertEq(pool.cap(usdg), held);
        MockUSDG(usdg).mint(saver, 1e6);
        vm.startPrank(saver);
        IERC20(usdg).approve(address(pool), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.CapExceeded.selector, held, 1e6, held));
        pool.deposit(usdg, 1e6, bytes32(uint256(7)), bytes32(uint256(11)), hex"01");
        vm.stopPrank();
    }

    /// v2: a conservative OI cap (audit PERP-4), the M-3 spread / minimum hold and the M-4 liquidation guards.
    function test_perpRiskParamsAreTheV2Ones() public {
        string memory json = _mainnetDeploy();
        string[4] memory syms = ["TSLA", "AAPL", "NVDA", "SPY"];
        for (uint256 i; i < syms.length; ++i) {
            PerpMarket m = PerpMarket(_a(json, string.concat("perpMarkets.", syms[i])));
            assertEq(m.oiCapBps(), 2_000);
            assertEq(m.openSpreadBps(), 40);
            assertEq(m.minHoldSeconds(), 30 minutes);
            assertEq(m.minLiquidationReward(), 1e6);
            assertEq(m.minCollateral(), 100e6);
            assertEq(m.takerFeeBps(), 10); // everything else untouched
            assertEq(m.maxProfitBps(), 10_000);
        }
        assertEq(PerpPool(_a(json, "perpPool")).TIMELOCK(), 48 hours);
        assertEq(PerpPool(_a(json, "perpPool")).totalSupply(), 0); // no LP seed from the deployer
    }

    function test_tokenOffMeansNoTokenAndFeesToOwner() public {
        string memory json = _mainnetDeploy();
        assertFalse(vm.keyExistsJson(json, ".plth"));
        assertFalse(vm.keyExistsJson(json, ".feeRouter"));
        TreasuryFactory f = TreasuryFactory(_a(json, "treasuryFactory"));
        assertEq(f.feeRecipient(), owner);
        assertEq(address(f.tiers()), address(0));
        assertFalse(vm.parseJsonBool(json, ".deployToken"));
    }

    function test_registryListsTheFourteenStockTokens() public {
        string memory json = _mainnetDeploy();
        assertEq(script.stocks().length, 14);
        assertEq(StockTokenRegistry(_a(json, "stockTokenRegistry")).tokens().length, 14);
        StockTokenRegistry reg = StockTokenRegistry(_a(json, "stockTokenRegistry"));
        StockRouter router = StockRouter(_a(json, "stockRouter"));
        MainnetBeta.Stock[] memory s = script.stocks();
        for (uint256 i; i < s.length; ++i) {
            StockTokenRegistry.Entry memory e = reg.entry(s[i].token);
            assertEq(e.feed, s[i].feed);
            assertTrue(e.multiplierEmbedded && e.active);
            assertEq(keccak256(abi.encode(router.poolOf(s[i].token))), keccak256(abi.encode(script.poolKeyOf(s[i]))));
        }
    }

    function test_forkModeRunsOn31337WithForkStaleness() public {
        MainnetBeta.Config memory c = _cfg();
        c.fork = true;
        c.maxStaleness = 7 days;
        vm.chainId(31337);
        string memory json = _deployWith(c);
        assertTrue(vm.parseJsonBool(json, ".fork"));
        assertEq(Valuer(_a(json, "valuer")).maxStaleness(), 7 days);
    }

    // ---------------------------------------------------------------- DEPLOY_TOKEN=true

    function test_tokenNeedsUsdgForThePlthPool() public {
        vm.chainId(4663);
        MainnetBeta.Config memory c = _cfg();
        c.deployToken = true;
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.NotEnoughUsdg.selector, 0, script.TOKEN_USDG_NEEDED()));
        script.deploy(c);
    }

    function test_tokenOnHandsTokenAdminToOwner() public {
        MainnetBeta.Config memory c = _cfg();
        c.deployToken = true;
        // forge's default broadcast sender in tests is the deployer here.
        MockUSDG(script.USDG()).mint(0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38, script.TOKEN_USDG_NEEDED());
        vm.chainId(4663);
        string memory json = _deployWith(c);
        address dep = _a(json, "deployer");
        assertEq(dep, 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);
        assertEq(Ownable(_a(json, "feeRouter")).owner(), owner);
        assertEq(FeeRouter(_a(json, "feeRouter")).keeper(), keeper);
        assertEq(FeeRouter(_a(json, "feeRouter")).perPushCap(), 200e6);
        assertEq(ExceptionInsurancePool(_a(json, "insurancePool")).committee(), owner);
        assertEq(ExceptionInsurancePool(_a(json, "insurancePool")).WITHDRAW_DELAY(), 14 days);
        PLTH plth = PLTH(_a(json, "plth"));
        assertEq(plth.balanceOf(dep), 0);
        assertGt(plth.balanceOf(owner), plth.totalSupply() * 9 / 10); // all but the pool seed
        TreasuryFactory f = TreasuryFactory(_a(json, "treasuryFactory"));
        assertEq(f.feeRecipient(), _a(json, "feeRouter"));
        assertEq(address(f.tiers()), _a(json, "staking"));
    }

    /// v2 oracle and crowd settings: calendar on (M-1), windows end 19:30 UTC so the public fallback hour is in US
    /// regular hours, valuer handed to OWNER, the tightened guard loss bound.
    function test_v2OracleCrowdAndGuardSettings() public {
        string memory json = _mainnetDeploy();
        Valuer v = Valuer(_a(json, "valuer"));
        assertTrue(v.marketCalendar());
        assertEq(IOwned2(address(v)).pendingOwner(), owner);
        uint64 g = uint64(vm.parseJsonUint(json, ".genesis"));
        assertEq(g % 1 days, 19 hours + 30 minutes);
        assertLe(g, block.timestamp);
        assertGt(g + 1 days, block.timestamp);
        assertEq(CrowdBuy(_a(json, "crowdBuy")).GENESIS(), g);
        assertEq(PolicyGuardLike(_a(json, "policyGuard")).maxOpLossBps(), 50);
    }

    /// The post-deploy check fails on a mismatch: a feed swapped after the delay is caught.
    function test_verifyDeploymentFailsOnAFeedMismatch() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        StockTokenRegistry reg = StockTokenRegistry(_a(json, "stockTokenRegistry"));
        MainnetBeta.Stock[] memory s = script.stocks();
        vm.prank(owner);
        reg.list(s[0].token, s[1].feed, true);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        reg.list(s[0].token, s[1].feed, true);
        string memory f = string.concat("verify-", vm.toString(uint256(uint32(msg.sig))), _suiteTag(), ".json");
        string memory path = string.concat(vm.projectRoot(), "/../app/deployments/", f);
        vm.writeFile(path, json);
        MainnetBeta v = new MainnetBeta();
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.HandoffIncomplete.selector, s[0].token, "TSLA feed"));
        v.verifyDeployment(f);
        vm.removeFile(path);
    }
}

interface PolicyGuardLike {
    function maxOpLossBps() external view returns (uint16);
}
