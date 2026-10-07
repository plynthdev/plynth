// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedTrade} from "../../src/consumer/ShieldedTrade.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {TestnetPoolSeeder} from "../../src/testnet/TestnetPoolSeeder.sol";
import {TestnetPoolMath} from "../../src/testnet/TestnetPoolMath.sol";
import {SwitchVerifier} from "./ShieldedPoolBase.sol";

/// Shared setup for ShieldedTrade: the REAL Uniswap v4 PoolManager runtime (fetched from Robinhood Chain 4663,
/// test/consumer/fixtures/v4_pool_manager.runtime.hex) etched at its canonical address, one full-range
/// mUSDG/mTSLA pool seeded at the oracle price, StockRouter, ShieldedPool + ShieldedTrade with stand-in
/// verifiers (real proofs: ShieldedTradeProofs.t.sol and the SDK anvil e2e).
abstract contract ShieldedTradeBase is Test {
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant P = Poseidon2.P;
    uint256 internal constant U = 1e6;
    uint16 internal constant BPS = 100; // StockRouter oracle slippage for these tests

    MockUSDG internal usdg;
    MockStockToken internal stock;
    MockFeed internal feed;
    StockTokenRegistry internal registry;
    Valuer internal valuer;
    StockRouter internal router;
    ShieldedPool internal pool;
    ShieldedTrade internal trade;
    SwitchVerifier internal tv;
    SwitchVerifier internal wv;
    SwitchVerifier internal sv;
    SwitchVerifier internal stv;
    PoolKey internal key;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal relayer = makeAddr("relayer");

    uint256 private _salt = 1;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.etch(PM, vm.parseBytes(string.concat("0x", vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/v4_pool_manager.runtime.hex")))));
        usdg = new MockUSDG();
        stock = new MockStockToken("Mock TSLA", "mTSLA");
        feed = new MockFeed(8, 250e8, "mTSLA / USD");
        registry = new StockTokenRegistry(address(this));
        registry.list(address(stock), address(feed), false);
        valuer = new Valuer(registry, 1 days);
        router = new StockRouter(IPoolManager(PM), registry, valuer, IERC20Metadata(address(usdg)), address(this));
        _seedPool(250e18, 500_000 * U);

        tv = new SwitchVerifier();
        wv = new SwitchVerifier();
        sv = new SwitchVerifier();
        stv = new SwitchVerifier();
        pool = new ShieldedPool(tv, wv, owner, 48 hours);
        trade = new ShieldedTrade(pool, sv, stv, router, owner, 48 hours);
        vm.prank(owner);
        pool.setTrade(address(trade));
        _raiseCap(address(usdg), 10_000_000 * U);
        _raiseCap(address(stock), 1_000_000e18);

        usdg.mint(alice, 10_000_000 * U);
        stock.mint(alice, 100_000e18);
        vm.startPrank(alice);
        usdg.approve(address(pool), type(uint256).max);
        stock.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _seedPool(uint256 priceUsd18, uint256 usdgSide) internal {
        bool usdgIs0 = address(usdg) < address(stock);
        key = usdgIs0
            ? PoolKey(address(usdg), address(stock), FEE, TICK_SPACING, IHooks(address(0)))
            : PoolKey(address(stock), address(usdg), FEE, TICK_SPACING, IHooks(address(0)));
        uint160 sqrtP = TestnetPoolMath.sqrtPriceX96For(priceUsd18, 6, 18, usdgIs0);
        uint128 liq = TestnetPoolMath.liquidityForUsdg(sqrtP, usdgSide, usdgIs0);
        TestnetPoolSeeder seeder = new TestnetPoolSeeder(IPoolManager(PM));
        usdg.mint(address(seeder), usdgSide * 101 / 100);
        stock.mint(address(seeder), TestnetPoolMath.tokenAmountFor(sqrtP, liq, usdgIs0) * 101 / 100);
        seeder.seed(key, sqrtP, liq);
        router.setPool(address(stock), key);
    }

    function _raiseCap(address asset, uint256 c) internal {
        vm.prank(owner);
        pool.proposeCap(asset, c);
        vm.warp(block.timestamp + pool.CAP_DELAY());
        pool.applyCap(asset);
        feed.set(250e8); // keep the oracle fresh across warps
    }

    /// Deposits and inserts one note for alice (commitment contents are irrelevant with stand-in verifiers).
    function _note(address asset, uint256 raw) internal {
        vm.prank(alice);
        pool.deposit(asset, raw, bytes32(uint256(keccak256(abi.encode(_salt++))) % P), bytes32(_salt), "");
        vm.warp(block.timestamp + pool.MIN_PENDING_DELAY());
        pool.insertPending(type(uint256).max);
        _refreshFeed();
    }

    function _refreshFeed() internal {
        (, int256 a,,,) = feed.latestRoundData();
        feed.set(a);
    }

    function _pub(address assetIn, uint256 amountIn, uint256 fee, address assetOut, uint256 minOut)
        internal
        returns (ShieldedTrade.PublicSwap memory s)
    {
        s.root = pool.currentRoot();
        s.nullifier = bytes32(uint256(keccak256(abi.encode("nullifier", _salt++))) % P);
        s.changeCommitment = bytes32(uint256(keccak256(abi.encode("change", _salt++))) % P);
        s.assetIn = assetIn;
        s.amountIn = amountIn;
        s.relayerFee = fee;
        s.assetOut = assetOut;
        s.minOut = minOut;
        s.outPartial = bytes32(uint256(keccak256(abi.encode("partial", _salt++))) % P);
        s.deadline = uint64(block.timestamp + 1 hours);
    }

    function _swap(ShieldedTrade.PublicSwap memory s) internal returns (uint256 out, bytes32 c) {
        vm.prank(relayer);
        (out, c) = trade.swap("", s, BPS, "", "");
    }

    /// Every asset the pool tracks is fully backed, and nothing sits in the module or the router.
    function _assertBacked(address[] memory assets) internal view {
        for (uint256 i; i < assets.length; ++i) {
            assertEq(IERC20(assets[i]).balanceOf(address(pool)), pool.shielded(assets[i]), "pool backed");
            assertEq(IERC20(assets[i]).balanceOf(address(trade)), 0, "module keeps nothing");
            assertEq(IERC20(assets[i]).balanceOf(address(router)), 0, "router keeps nothing");
        }
    }

    function _two(address a, address b) internal pure returns (address[] memory xs) {
        xs = new address[](2);
        xs[0] = a;
        xs[1] = b;
    }
}
