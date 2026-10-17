// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {Tier} from "../../src/interfaces/ITierSource.sol";
import {IPoolManager} from "../../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockERC20, MockPoolManager} from "../mocks/MockV4.sol";
import {SwitchVerifier} from "../consumer/ShieldedPoolBase.sol";

/// Every timer that used to be a constant is now a deploy-time immutable with a hard minimum, so a mainnet
/// deploy cannot set it dangerously low while testnet can finish every time-bound step the same day.
/// For each: below the minimum reverts, the minimum works, the mainnet value and the testnet value (15 min)
/// are both honoured exactly (one second early reverts, on time works), fuzzed over [minimum, 30 days].
contract DeployTimersTest is Test {
    uint64 constant T0 = 1_800_000_000;
    uint64 constant TESTNET = 15 minutes;
    address board = makeAddr("board");
    address controller = makeAddr("controller");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(T0);
    }

    // ------------------------------------------------------------------ JitterBeacon.GRACE

    function test_beacon_graceMinimum() public {
        vm.expectRevert(JitterBeacon.GraceTooShort.selector);
        new JitterBeacon(keeper, board, 10 minutes - 1);
        assertEq(new JitterBeacon(keeper, board, 10 minutes).GRACE(), 10 minutes);
        assertEq(new JitterBeacon(keeper, board, 1 hours).GRACE(), 1 hours);
    }

    function testFuzz_beacon_graceSetsFallbackAndRevealCutoff(uint64 grace) public {
        grace = uint64(bound(grace, 10 minutes, 1 days));
        JitterBeacon b = new JitterBeacon(keeper, board, grace);
        uint64 start = T0 + 1 hours;
        uint64 end = start + grace + 1 hours;
        bytes32 key = keccak256("k");
        bytes32 secret = keccak256("s");
        vm.prank(keeper);
        b.commit(key, start, end, keccak256(abi.encode(secret, key)));
        assertEq(b.executeAfter(key), end - grace, "fallback = windowEnd - GRACE");
        uint64 off = b.offsetOf(secret, key, start, end);
        assertLt(off, end - start - grace);
        vm.warp(end - grace);
        vm.expectRevert(JitterBeacon.RevealTooLate.selector);
        b.reveal(key, secret);
        vm.warp(start + off);
        b.reveal(key, secret);
        assertEq(b.executeAfter(key), start + off);
    }

    function test_beacon_windowMustExceedGrace() public {
        JitterBeacon b = new JitterBeacon(keeper, board, TESTNET);
        vm.startPrank(keeper);
        vm.expectRevert(JitterBeacon.WindowTooShort.selector);
        b.commit(keccak256("a"), T0 + 1, T0 + 1 + TESTNET, bytes32(uint256(1)));
        b.commit(keccak256("a"), T0 + 1, T0 + 2 + TESTNET, bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ ShieldedPool.CAP_DELAY

    function _pool(uint64 d) internal returns (ShieldedPool) {
        return new ShieldedPool(new SwitchVerifier(), new SwitchVerifier(), board, d);
    }

    function test_pool_capDelayMinimum() public {
        IHonkVerifier v = new SwitchVerifier();
        vm.expectRevert(ShieldedPool.DelayTooShort.selector);
        new ShieldedPool(v, v, board, 10 minutes - 1);
        assertEq(_pool(10 minutes).CAP_DELAY(), 10 minutes);
    }

    function testFuzz_pool_capRaiseWaitsExactlyCapDelay(uint64 d) public {
        d = uint64(bound(d, 10 minutes, 30 days));
        _poolCapAfter(d);
    }

    function test_pool_mainnetAndTestnetCapDelay() public {
        _poolCapAfter(48 hours);
        _poolCapAfter(TESTNET);
    }

    function _poolCapAfter(uint64 d) internal {
        ShieldedPool p = _pool(d);
        address asset = makeAddr("asset");
        uint256 t = block.timestamp;
        vm.prank(board);
        p.proposeCap(asset, 1e18);
        vm.warp(t + d - 1);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TooEarly.selector, uint64(t + d)));
        p.applyCap(asset);
        vm.warp(t + d);
        p.applyCap(asset);
        assertEq(p.cap(asset), 1e18);
        vm.warp(t);
    }

    // ------------------------------------------------------------------ ShieldedTrade.ADAPTER_DELAY

    function test_trade_adapterDelayMinimum() public {
        MockUSDG usdg = new MockUSDG();
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        Valuer valuer = new Valuer(reg, 1 hours);
        StockRouter router = new StockRouter(
            IPoolManager(address(new MockPoolManager())), reg, valuer, IERC20Metadata(address(usdg)), board
        );
        ShieldedPool p = _pool(TESTNET);
        IHonkVerifier v = new SwitchVerifier();
        vm.expectRevert(ShieldedTrade.DelayTooShort.selector);
        new ShieldedTrade(p, v, v, router, board, 10 minutes - 1);
        assertEq(new ShieldedTrade(p, v, v, router, board, 10 minutes).ADAPTER_DELAY(), 10 minutes);
        assertEq(new ShieldedTrade(p, v, v, router, board, TESTNET).ADAPTER_DELAY(), TESTNET);
        assertEq(new ShieldedTrade(p, v, v, router, board, 48 hours).ADAPTER_DELAY(), 48 hours);
    }

    // ------------------------------------------------------------------ TreasuryPolicy.TIMELOCK

    function _good() internal view returns (TreasuryPolicy.Policy memory p) {
        p.cash = TreasuryPolicy.Band(7000, 9000);
        p.equity = TreasuryPolicy.Band(1000, 3000);
        p.perOrderCapUsd = 50_000;
        p.perDayCapUsd = 250_000;
        p.perNameFloatCapBps = 50;
        p.noNewRiskOffHours = true;
        p.pauseNewRiskAtDrawdownBps = -300;
        p.deriskAtDrawdownBps = -600;
        p.approvalAboveUsd = 25_000;
        p.periodSeconds = 30 days;
        p.instrumentAllowRoot = keccak256("root");
        p.controller = controller;
    }

    function test_policy_timelockMinimum() public {
        vm.expectRevert(TreasuryPolicy.TimelockTooShort.selector);
        new TreasuryPolicy(board, _good(), 10 minutes - 1);
        TreasuryPolicy.Policy memory none;
        vm.expectRevert(TreasuryPolicy.TimelockTooShort.selector);
        new TreasuryPolicy(address(0), none, 0); // the locked implementation is checked too (clones share it)
        assertEq(new TreasuryPolicy(board, _good(), 10 minutes).TIMELOCK(), 10 minutes);
    }

    function testFuzz_policy_activationWaitsExactlyTimelock(uint64 d) public {
        d = uint64(bound(d, 10 minutes, 30 days));
        _policyAfter(d);
    }

    function test_policy_mainnetAndTestnetTimelock() public {
        _policyAfter(48 hours);
        _policyAfter(TESTNET);
    }

    function _policyAfter(uint64 d) internal {
        TreasuryPolicy tp = new TreasuryPolicy(board, _good(), d);
        uint256 t = block.timestamp;
        TreasuryPolicy.Policy memory p = _good();
        p.perDayCapUsd = 200_000;
        vm.prank(board);
        tp.propose(p);
        vm.warp(t + d - 1);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.TimelockActive.selector, uint64(t + d)));
        tp.activate();
        vm.warp(t + d);
        tp.activate();
        (,, uint32 v) = tp.current();
        assertEq(v, 2);
        vm.warp(t);
    }

    // ------------------------------------------------------------------ PlinthStaking.UNBONDING

    function _staking(uint256 d) internal returns (PlinthStaking s, MockERC20 plth) {
        plth = new MockERC20("PLTH", 18);
        MockERC20 usdg = new MockERC20("USDG", 6);
        PlinthStaking.TierSpec[] memory t = new PlinthStaking.TierSpec[](1);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        s = new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), t, d);
    }

    function test_staking_unbondingMinimum() public {
        vm.expectRevert(PlinthStaking.DelayTooShort.selector);
        this.deployStaking(10 minutes - 1);
        (PlinthStaking s,) = _staking(10 minutes);
        assertEq(s.UNBONDING(), 10 minutes);
    }

    function deployStaking(uint256 d) external {
        _staking(d);
    }

    function testFuzz_staking_withdrawWaitsExactlyUnbonding(uint256 d) public {
        d = bound(d, 10 minutes, 30 days);
        _unbondAfter(d);
    }

    function test_staking_mainnetAndTestnetUnbonding() public {
        _unbondAfter(7 days);
        _unbondAfter(TESTNET);
    }

    function _unbondAfter(uint256 d) internal {
        (PlinthStaking s, MockERC20 plth) = _staking(d);
        uint256 t = block.timestamp;
        plth.mint(alice, 100e18);
        vm.startPrank(alice);
        plth.approve(address(s), 100e18);
        s.stake(100e18);
        s.unstake(100e18);
        vm.warp(t + d - 1);
        vm.expectRevert(abi.encodeWithSelector(PlinthStaking.StillUnbonding.selector, uint64(t + d)));
        s.withdraw();
        vm.warp(t + d);
        assertEq(s.withdraw(), 100e18);
        vm.stopPrank();
        vm.warp(t);
    }

    // ------------------------------------------------------------------ ExceptionInsurancePool.WITHDRAW_DELAY

    function test_insurance_withdrawDelayMinimum() public {
        MockERC20 usdg = new MockERC20("USDG", 6);
        vm.expectRevert(ExceptionInsurancePool.DelayTooShort.selector);
        new ExceptionInsurancePool(IERC20Metadata(address(usdg)), board, 10 minutes - 1);
        assertEq(new ExceptionInsurancePool(IERC20Metadata(address(usdg)), board, 10 minutes).WITHDRAW_DELAY(), 10 minutes);
    }

    function testFuzz_insurance_withdrawWaitsExactlyDelay(uint256 d) public {
        d = bound(d, 10 minutes, 30 days);
        _insuranceAfter(d);
    }

    function test_insurance_mainnetAndTestnetDelay() public {
        _insuranceAfter(14 days);
        _insuranceAfter(TESTNET);
    }

    function _insuranceAfter(uint256 d) internal {
        MockERC20 usdg = new MockERC20("USDG", 6);
        ExceptionInsurancePool p = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), board, d);
        uint256 t = block.timestamp;
        usdg.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdg.approve(address(p), 1000e6);
        uint256 shares = p.deposit(1000e6);
        p.requestWithdraw(shares);
        vm.warp(t + d - 1);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.NotReady.selector, uint64(t + d)));
        p.withdraw();
        vm.warp(t + d);
        assertGt(p.withdraw(), 0);
        vm.stopPrank();
        vm.warp(t);
    }

    // ------------------------------------------------------------------ PerpPool.REDEEM_COOLDOWN

    function test_perpPool_cooldownMinimum() public {
        MockUSDG usdg = new MockUSDG();
        vm.expectRevert(PerpPool.CooldownTooShort.selector);
        new PerpPool(usdg, board, 10 minutes - 1, 48 hours);
        assertEq(new PerpPool(usdg, board, 10 minutes, 48 hours).REDEEM_COOLDOWN(), 10 minutes);
    }

    function testFuzz_perpPool_redeemWaitsExactlyCooldown(uint256 d) public {
        d = bound(d, 10 minutes, 30 days);
        _redeemAfter(d);
    }

    function test_perpPool_mainnetAndTestnetCooldown() public {
        _redeemAfter(24 hours);
        _redeemAfter(TESTNET);
    }

    function _redeemAfter(uint256 d) internal {
        MockUSDG usdg = new MockUSDG();
        PerpPool p = new PerpPool(usdg, board, d, 48 hours);
        uint256 t = block.timestamp;
        usdg.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdg.approve(address(p), 1000e6);
        uint256 shares = p.deposit(1000e6, alice);
        vm.warp(t + d - 1);
        assertEq(p.maxRedeem(alice), 0, "nothing redeemable inside the cooldown");
        vm.expectRevert(); // ERC4626ExceededMaxRedeem: maxRedeem is 0 until the cooldown ends
        p.redeem(shares, alice, alice);
        vm.warp(t + d);
        assertEq(p.maxRedeem(alice), shares);
        assertEq(p.redeem(shares, alice, alice), 1000e6);
        vm.stopPrank();
        vm.warp(t);
    }
}
