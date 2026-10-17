// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MainnetBetaTest} from "../script/MainnetBeta.t.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// Review v2 (2026-10-16) deploy + admin PoCs (rv2-deploy DeployAdminReview.t.sol), turned into regression tests that
/// assert the safe behaviour. Run: forge test --match-contract DeployAdminRegression
contract DeployAdminRegression is MainnetBetaTest {
    // 2026-11-25 21:00 UTC (Wed, last round before Thanksgiving) and 2026-11-26 15:00 UTC (Thanksgiving, NYSE closed)
    uint256 constant WED_CLOSE = 1795640400;
    uint256 constant THANKSGIVING_1500 = 1795705200;

    function _valuer() internal returns (Valuer v, MockStockToken t, MockFeed f) {
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        t = new MockStockToken("T", "T");
        f = new MockFeed(8, 100e8, "T");
        reg.list(address(t), address(f), true);
        v = new Valuer(reg, script.DEFAULT_MAX_STALENESS());
        v.enableMarketCalendar();
    }

    function _writeJson(string memory json) internal returns (string memory f, string memory path) {
        f = string.concat("rv-", vm.toString(uint256(uint32(msg.sig))), ".json");
        path = string.concat(vm.projectRoot(), "/../app/deployments/", f);
        vm.writeFile(path, json);
    }

    /// V2-M1: the deployed Valuer marks Thanksgiving (and the whole NYSE table) closed and holds it.
    function test_RV_holidayIsHeld() public {
        vm.chainId(4663);
        string memory json = _deploy();
        Valuer dv = Valuer(_a(json, "valuer"));
        assertTrue(dv.closedDay(THANKSGIVING_1500 / 1 days), "deploy marks Thanksgiving closed");
        assertEq(dv.calendarValidUntil(), script.CALENDAR_VALID_UNTIL());
        uint256[] memory closed = script.nyseClosedDays();
        for (uint256 i; i < closed.length; ++i) assertTrue(dv.closedDay(closed[i]));
        uint256[] memory early = script.nyseEarlyCloses();
        for (uint256 i; i < early.length; ++i) assertTrue(dv.earlyCloseDay(early[i]));
        // The deploy's own feed: a Wednesday-close round is not tradable on Thanksgiving.
        MainnetBeta.Stock[] memory s = script.stocks();
        vm.warp(WED_CLOSE);
        MockFeed(s[0].feed).set(100e8);
        vm.warp(THANKSGIVING_1500);
        assertTrue(dv.marketClosed());
        assertTrue(dv.quote(s[0].token).hold);
    }

    /// V2-M1: checkConfig refuses a deploy whose holiday table covers less than 24 months.
    function test_RV_calendarMustCoverTwoYears() public {
        uint256 until = script.CALENDAR_VALID_UNTIL();
        script.checkCalendar(until - 730 days);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.BadCalendar.selector, until, until - 730 days + 1));
        script.checkCalendar(until - 730 days + 1);
        vm.warp(until - 700 days);
        vm.expectRevert();
        script.checkConfig(_cfg(), makeAddr("deployer"));
    }

    /// V2-L5: an EOA (a typo) cannot be set as the sequencer feed; a real one waits 48 h and stays replaceable.
    function test_RV_sequencerFeedEoaRefused() public {
        (Valuer v,,) = _valuer();
        address eoa = makeAddr("typo-eoa");
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadSequencerFeed.selector, eoa));
        v.setSequencerFeed(AggregatorV3Interface(eoa));
        assertEq(address(v.sequencerFeed()), address(0));
        MockFeed seq = new MockFeed(0, 0, "seq");
        v.setSequencerFeed(AggregatorV3Interface(address(seq)));
        assertEq(address(v.sequencerFeed()), address(0), "48 h first");
    }

    /// V2-L6: a ChangeDelay entry expires 14 days after its eta: the same call a year later only queues it again.
    function test_RV_changeDelayExpires() public {
        address k1 = makeAddr("k1");
        address evil = makeAddr("evil");
        JitterBeacon b = new JitterBeacon(k1, address(this), 1 hours);
        b.setKeeper(evil); // queued, public event
        vm.warp(block.timestamp + 365 days);
        b.setKeeper(evil); // expired: queued again with a fresh notice, not applied
        assertEq(b.keeper(), k1);
        vm.warp(block.timestamp + 48 hours);
        b.setKeeper(evil);
        assertEq(b.keeper(), evil);
        // Boundary: usable through eta + CHANGE_EXPIRY, not after.
        b.setKeeper(k1);
        uint256 eta = b.changeEta(b.changeId(abi.encodeCall(JitterBeacon.setKeeper, (k1))));
        vm.warp(eta + 14 days + 1);
        b.setKeeper(k1);
        assertEq(b.keeper(), evil);
    }

    /// V2-L6: an entry queued by the deployer is void after the hand-over: the new owner needs its own notice.
    function test_RV_queuedChangeVoidAfterOwnershipTransfer() public {
        address k1 = makeAddr("k1");
        address evil = makeAddr("evil");
        address newOwner = makeAddr("newOwner");
        JitterBeacon b = new JitterBeacon(k1, address(this), 1 hours);
        b.setKeeper(evil);
        bytes32 id = b.changeId(abi.encodeCall(JitterBeacon.setKeeper, (evil)));
        assertGt(b.changeEta(id), 0);
        b.transferOwnership(newOwner);
        assertTrue(b.changeId(abi.encodeCall(JitterBeacon.setKeeper, (evil))) != id, "the nonce moved");
        vm.warp(block.timestamp + 48 hours);
        vm.prank(newOwner);
        b.setKeeper(evil); // queues under the new owner
        assertEq(b.keeper(), k1);
    }

    /// V2-L20: strict verification fails while the hand-over is unaccepted, and passes once OWNER accepted.
    function test_RV_verifyDeploymentStrictNeedsAcceptOwnership() public {
        string memory json = _mainnetDeploy();
        (string memory f, string memory path) = _writeJson(json);
        MainnetBeta v = new MainnetBeta();
        v.verifyDeployment(f); // the lenient check still passes between deploy and accept
        MainnetBeta strict = new MainnetBeta();
        vm.expectRevert();
        strict.verifyDeploymentStrict(f);
        _acceptAll(json);
        MainnetBeta strict2 = new MainnetBeta();
        strict2.verifyDeploymentStrict(f);
        vm.removeFile(path);
    }

    /// V2-L21: the setters that could switch a guard off or swap a trust root wait 48 h now.
    function test_RV_safetySettersAreDelayed() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        ShieldedPool sp = ShieldedPool(_a(json, "shieldedPool"));
        EligibilityRegistry el = EligibilityRegistry(_a(json, "eligibilityRegistry"));
        uint256 min0 = sp.minDeposit(script.USDG());
        vm.startPrank(owner);
        sp.setMinDeposit(script.USDG(), 0); // only queued
        el.setAttester(makeAddr("newAttester")); // only queued
        sp.setMinDeposit(script.USDG(), min0 * 2); // raising stays instant
        vm.stopPrank();
        assertEq(sp.minDeposit(script.USDG()), min0 * 2);
        assertEq(el.attester(), attester);
    }

    /// V2-L22: in mainnet mode an EOA OWNER is refused unless ALLOW_EOA_OWNER is set explicitly.
    function test_RV_eoaOwnerRefusedInMainnetMode() public {
        MainnetBeta.Config memory c = _cfg();
        address eoa = makeAddr("eoa-owner");
        c.owner = eoa;
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.OwnerNotContract.selector, eoa));
        script.checkConfig(c, makeAddr("deployer"));
        c.allowEoaOwner = true;
        script.checkConfig(c, makeAddr("deployer"));
        c.allowEoaOwner = false;
        c.fork = true; // the fork dry run may use an EOA
        script.checkConfig(c, makeAddr("deployer"));
        vm.setEnv("ALLOW_EOA_OWNER", "1");
        assertTrue(script.loadConfig().allowEoaOwner);
        vm.setEnv("ALLOW_EOA_OWNER", "0");
        assertFalse(script.loadConfig().allowEoaOwner);
    }

    /// V2-L24: mainnet mode pins MAX_STALENESS <= 26 h and MIN_CROWD >= 3 (the review: 7 d and 1 were accepted).
    function test_RV_mainnetPinsStalenessAndMinCrowd() public {
        MainnetBeta.Config memory c = _cfg();
        c.maxStaleness = 7 days;
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.BadStaleness.selector, 7 days));
        script.checkConfig(c, makeAddr("deployer"));
        c.maxStaleness = 26 hours;
        c.minCrowd = 1;
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.BadMinCrowd.selector, 1));
        script.checkConfig(c, makeAddr("deployer"));
        c.fork = true;
        c.maxStaleness = 7 days;
        script.checkConfig(c, makeAddr("deployer"));
    }

    /// V2-L7: a stranger's 1-unit deposit right after the pool is created is refused, so the deploy's instant
    /// addMarket cannot be pushed behind the timelock.
    function test_RV_perpDeployNotGriefable() public {
        (Valuer v, MockStockToken t,) = _valuer();
        v.setCalendarValidUntil(block.timestamp + 365 days);
        MockUSDG usdg = new MockUSDG();
        PerpPool pool = new PerpPool(IERC20(address(usdg)), address(this), 24 hours, 48 hours);
        address griefer = makeAddr("griefer");
        usdg.mint(griefer, 1);
        vm.startPrank(griefer);
        usdg.approve(address(pool), 1);
        vm.expectRevert(PerpPool.DepositsClosed.selector);
        pool.deposit(1, griefer);
        vm.stopPrank();
        assertEq(pool.maxDeposit(griefer), 0);
        PerpMarket m = new PerpMarket(pool, v, address(t), address(this));
        pool.addMarket(address(m)); // still instant: no LP can exist yet
        assertTrue(pool.isMarket(address(m)));
        pool.openDeposits();
        vm.expectRevert(PerpPool.AlreadyOpen.selector);
        pool.openDeposits(); // one-way
        vm.prank(griefer);
        vm.expectRevert();
        pool.openDeposits(); // owner only (already open anyway)
        // And the mainnet deploy ends with deposits open, every market listed.
        string memory json = _mainnetDeploy();
        assertTrue(PerpPool(_a(json, "perpPool")).depositsOpen());
    }
}
