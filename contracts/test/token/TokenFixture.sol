// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PLTH} from "../../src/token/PLTH.sol";
import {PlinthStaking} from "../../src/token/PlinthStaking.sol";
import {FeeRouter, IStakingRewards, IInsuranceFees} from "../../src/token/FeeRouter.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {Tier} from "../../src/interfaces/ITierSource.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockERC20, MockPoolManager} from "../mocks/MockV4.sol";

abstract contract TokenFixture is Test {
    uint64 constant T0 = 1_800_000_000; // a whole hour (1_800_000_000 / 3600 = 500_000)
    uint256 constant T1_MIN = 10_000e18;
    uint256 constant T2_MIN = 100_000e18;
    uint256 constant T3_MIN = 1_000_000e18;
    // 1 PLTH = 0.05 USDG: PLTH raw per USDG raw = 20e18 / 1e6 = 2e13
    uint256 constant PLTH_PER_USDG_RAW = 2e13;

    address worker = makeAddr("worker");
    address plthTreasury = makeAddr("plthTreasury");
    address reserve = makeAddr("reserve");
    address committee = makeAddr("committee");
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    PLTH plth;
    MockERC20 usdg;
    PlinthStaking staking;
    ExceptionInsurancePool insurance;
    MockPoolManager pm;
    FeeRouter router;
    PoolKey key;

    function _tiers() internal pure returns (PlinthStaking.TierSpec[] memory t) {
        t = new PlinthStaking.TierSpec[](4);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        t[1] = PlinthStaking.TierSpec(T1_MIN, Tier(4, true, false, 1));
        t[2] = PlinthStaking.TierSpec(T2_MIN, Tier(8, true, true, 2));
        t[3] = PlinthStaking.TierSpec(T3_MIN, Tier(16, true, true, 3));
    }

    function setUp() public virtual {
        vm.warp(T0);
        plth = new PLTH(worker, plthTreasury, reserve);
        usdg = new MockERC20("USDG", 6);
        staking = new PlinthStaking(IERC20(address(plth)), IERC20(address(usdg)), _tiers(), 7 days);
        insurance = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, 14 days);
        pm = new MockPoolManager();
        bool u0 = address(usdg) < address(plth);
        key = u0
            ? PoolKey(address(usdg), address(plth), 3000, 60, IHooks(address(0)))
            : PoolKey(address(plth), address(usdg), 3000, 60, IHooks(address(0)));
        _setPrice(PLTH_PER_USDG_RAW * 1e18);
        router = new FeeRouter(
            IERC20(address(usdg)),
            IERC20(address(plth)),
            IStakingRewards(address(staking)),
            IInsuranceFees(address(insurance)),
            IPoolManager(address(pm)),
            key,
            100, // 1% (pool fee 0.3% fits inside)
            10_000e6,
            owner
        );
        insurance.bindFeeRouter(address(router));
        vm.prank(worker);
        plth.transfer(address(pm), 100_000_000e18); // pool-side PLTH liquidity for the mock
        usdg.mint(address(pm), 1_000_000e6);
    }

    /// Sets both the mock's fill rate and its slot0 to `plthPerUsdgX18` (PLTH raw per USDG raw, 1e18-scaled).
    function _setPrice(uint256 plthPerUsdgX18) internal {
        _setFillRate(plthPerUsdgX18);
        _setSpot(plthPerUsdgX18);
    }

    function _setFillRate(uint256 plthPerUsdgX18) internal {
        bool u0 = key.currency0 == address(usdg);
        pm.setRate(key, u0 ? plthPerUsdgX18 : 1e36 / plthPerUsdgX18);
    }

    function _setSpot(uint256 plthPerUsdgX18) internal {
        bool u0 = key.currency0 == address(usdg);
        uint256 r = u0 ? plthPerUsdgX18 : 1e36 / plthPerUsdgX18; // currency1 per currency0, 1e18-scaled
        pm.setSqrtPrice(key, uint160(Math.sqrt(Math.mulDiv(r, 1 << 192, 1e18))));
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(worker);
        plth.transfer(to, amount);
    }

    function _stake(address who, uint256 amount) internal {
        _give(who, amount);
        vm.startPrank(who);
        plth.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _notify(address token, uint256 amount) internal {
        if (token == address(usdg)) usdg.mint(address(this), amount);
        else _give(address(this), amount);
        IERC20(token).approve(address(staking), amount);
        staking.notifyReward(token, amount);
    }

    function _nextHour() internal {
        vm.warp((block.timestamp / 1 hours + 1) * 1 hours);
    }
}
