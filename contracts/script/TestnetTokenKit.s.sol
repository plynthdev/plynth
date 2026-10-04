// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks, IPoolManager, PoolKey} from "../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";
import {TestnetPoolSeeder} from "../src/testnet/TestnetPoolSeeder.sol";
import {TestnetPoolMath} from "../src/testnet/TestnetPoolMath.sol";
import {PLTH} from "../src/token/PLTH.sol";
import {PlinthStaking} from "../src/token/PlinthStaking.sol";
import {FeeRouter, IStakingRewards, IInsuranceFees} from "../src/token/FeeRouter.sol";
import {ExceptionInsurancePool} from "../src/token/ExceptionInsurancePool.sol";
import {Tier} from "../src/interfaces/ITierSource.sol";

/// Testnet kit, token part: PLTH, a PLTH/mUSDG Uniswap v4 pool on the chain's real PoolManager (~50k mUSDG a
/// side at 0.05 mUSDG per PLTH), PlinthStaking with four tiers, the ExceptionInsurancePool and the FeeRouter.
/// Runs after TestnetKit: `run()` reads deployments/<chainid>.json (mUSDG; the deployer must own it) and
/// writes deployments/<chainid>-token.json.
/// PLTH allocation recipients and the insurance committee are deploy params (env PLTH_WORKER,
/// PLTH_TREASURY, PLTH_STAKER_RESERVE, INSURANCE_COMMITTEE; each defaults to the deployer). The worker
/// allocation must belong to the deployer, which funds the pool's PLTH side from it.
contract TestnetTokenKit is Script {
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant PLTH_PRICE = 0.05e18; // USD per PLTH
    uint256 public constant USDG_PER_SIDE = 50_000e6;
    uint256 public constant HEADROOM_BPS = 100;
    uint16 public constant MAX_SLIPPAGE_BPS = 100;
    uint256 public constant PER_PUSH_CAP = 200e6; // ~0.4% price impact on 50k a side + 0.3% fee < 1% bound

    struct Params {
        address worker;
        address plthTreasury;
        address stakerReserve;
        address committee;
    }

    struct Deployment {
        PLTH plth;
        PlinthStaking staking;
        ExceptionInsurancePool insurance;
        FeeRouter router;
        TestnetPoolSeeder seeder;
        PoolKey key;
        bytes32 poolId;
    }

    function run() external returns (Deployment memory d) {
        string memory path = string.concat(vm.projectRoot(), "/../app/deployments/", vm.toString(block.chainid), ".json");
        MockUSDG usdg = MockUSDG(vm.parseJsonAddress(vm.readFile(path), ".usdg"));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Params memory p = Params(
            vm.envOr("PLTH_WORKER", deployer),
            vm.envOr("PLTH_TREASURY", deployer),
            vm.envOr("PLTH_STAKER_RESERVE", deployer),
            vm.envOr("INSURANCE_COMMITTEE", deployer)
        );
        d = _deploy(deployer, usdg, p);
        vm.stopBroadcast();
        _write(d, p);
    }

    /// Same deployment without broadcasting or writing files, for tests.
    function deployAs(address deployer, MockUSDG usdg, Params memory p) external returns (Deployment memory d) {
        vm.startPrank(deployer);
        d = _deploy(deployer, usdg, p);
        vm.stopPrank();
    }

    function tiers() public pure returns (PlinthStaking.TierSpec[] memory t) {
        t = new PlinthStaking.TierSpec[](4);
        t[0] = PlinthStaking.TierSpec(0, Tier(2, false, false, 0));
        t[1] = PlinthStaking.TierSpec(10_000e18, Tier(4, true, false, 1));
        t[2] = PlinthStaking.TierSpec(100_000e18, Tier(8, true, true, 2));
        t[3] = PlinthStaking.TierSpec(1_000_000e18, Tier(16, true, true, 3));
    }

    function _deploy(address deployer, MockUSDG usdg, Params memory p) internal returns (Deployment memory d) {
        IPoolManager pm = IPoolManager(POOL_MANAGER);
        d.plth = new PLTH(p.worker, p.plthTreasury, p.stakerReserve);
        d.staking = new PlinthStaking(IERC20(address(d.plth)), IERC20(address(usdg)), tiers());
        d.insurance = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), p.committee);

        d.seeder = new TestnetPoolSeeder(pm);
        (d.key, d.poolId) = _seedPool(d.seeder, usdg, d.plth);

        d.router = new FeeRouter(
            IERC20(address(usdg)),
            IERC20(address(d.plth)),
            IStakingRewards(address(d.staking)),
            IInsuranceFees(address(d.insurance)),
            pm,
            d.key,
            MAX_SLIPPAGE_BPS,
            PER_PUSH_CAP,
            deployer
        );
    }

    function _seedPool(TestnetPoolSeeder seeder, MockUSDG usdg, PLTH plth)
        internal
        returns (PoolKey memory key, bytes32 poolId)
    {
        bool usdgIs0 = address(usdg) < address(plth);
        key = usdgIs0
            ? PoolKey(address(usdg), address(plth), FEE, TICK_SPACING, IHooks(address(0)))
            : PoolKey(address(plth), address(usdg), FEE, TICK_SPACING, IHooks(address(0)));
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(PLTH_PRICE, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, USDG_PER_SIDE, usdgIs0);
        uint256 plthNeed = TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0);
        usdg.mint(address(seeder), USDG_PER_SIDE * (10_000 + HEADROOM_BPS) / 10_000);
        IERC20(address(plth)).transfer(address(seeder), plthNeed * (10_000 + HEADROOM_BPS) / 10_000);
        (poolId,) = seeder.seed(key, sqrtP, liq);
    }

    function _write(Deployment memory d, Params memory p) internal {
        string memory root = "token";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployBlock", vm.getBlockNumber());
        vm.serializeAddress(root, "plth", address(d.plth));
        vm.serializeAddress(root, "staking", address(d.staking));
        vm.serializeAddress(root, "insurancePool", address(d.insurance));
        vm.serializeAddress(root, "feeRouter", address(d.router));
        vm.serializeAddress(root, "poolSeeder", address(d.seeder));
        vm.serializeAddress(root, "insuranceCommittee", p.committee);
        vm.serializeAddress(root, "plthWorker", p.worker);
        vm.serializeAddress(root, "plthTreasury", p.plthTreasury);
        vm.serializeAddress(root, "plthStakerReserve", p.stakerReserve);
        string memory json = vm.serializeBytes32(root, "plthPoolId", d.poolId);
        string memory dir = string.concat(vm.projectRoot(), "/../app/deployments");
        vm.writeJson(json, string.concat(dir, "/", vm.toString(block.chainid), "-token.json"));
    }
}
