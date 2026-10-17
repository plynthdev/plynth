// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon} from "../../src/consumer/CrowdBuy.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {
    IPoolManager, IUnlockCallback, PoolKey, SwapParams, V4Constants
} from "../../src/interfaces/IUniswapV4.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Moves a real v4 pool to a price limit with exact-input swaps (the stranger's push before a public execution).
contract V4Pusher is IUnlockCallback {
    using SafeERC20 for IERC20;
    using V4Constants for int256;

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function push(PoolKey memory key, address tokenIn, uint160 sqrtPriceLimitX96) external {
        pm.unlock(abi.encode(key, tokenIn, sqrtPriceLimitX96));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, address tokenIn, uint160 limit) = abi.decode(data, (PoolKey, address, uint160));
        bool z = tokenIn == key.currency0;
        uint256 bal = IERC20(tokenIn).balanceOf(address(this));
        int256 d = pm.swap(key, SwapParams(z, -int256(bal), limit), "");
        (int128 dIn, int128 dOut) = z ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 used = uint256(int256(-dIn));
        uint256 out = uint256(int256(dOut));
        pm.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(pm), used);
        pm.settle();
        if (out != 0) pm.take(z ? key.currency1 : key.currency0, address(this), out);
        return "";
    }
}

/// Review v3, V2-L4 / R3-ORC-1 (strengthens CrowdBuy.t.sol::test_V2L4_publicFallbackRefusesAPushedPool, which
/// modelled pool = fresh oracle only). Real CrowdBuy + SavingsVault + JitterBeacon + StockRouter + Valuer +
/// StockTokenRegistry, wired as MainnetBeta wires them (26 h staleness, NYSE calendar, MIN_CROWD 3, keeper band 100
/// bps, 1-day windows at 19:30 UTC, GRACE 1 h), trading against the REAL Uniswap v4 PoolManager and the real
/// USDG/SPY (fee 500 = 5 bps) and USDG/NVDA (fee 100 = 1 bps) pools on a Robinhood Chain mainnet fork. The price
/// source is a Chainlink-shaped MockFeed the test sets relative to the live pool price. Skips without
/// RHC_MAINNET_RPC_URL. Nothing is broadcast.
///
/// Oracle lag: the round is fresh (10 min old, published after the book's public time), but the market has moved
/// 49 bps since (under the 50 bps deviation threshold, so no new round). The pool sits at the real price T.
///   - Market UP 49 bps: buying at T is 49 bps worse than the oracle allows with a 15 / 11 bps band -> refused.
///   - Market DOWN 49 bps: the stranger pushes the pool up to the very edge of what the router's oracle minOut still
///     accepts (found by bisection over the push, with the book's own price impact and the pool fee included) and
///     executes. The book's loss against T is bounded by the router's minOut alone:
///         loss <= 1 - (1 - band) x (1 - lag),  band = publicSlippageBps = pool fee + 10 bps
///     and the bisection shows the bound is reached. Its supremum (lag -> 50 bps): 64.925 bps on the 5 bps SPY pool,
///     60.945 bps on the 1 bps NVDA pool.
/// FINDING (doc precision): R3-ORC-1 states the loss is "<= about 60 bps on 1-5 bps pools". That holds for 1 bps
/// pools; on a 5 bps pool (SPY) the real contracts allow up to ~65 bps (measured below). Not fixed here.
contract RV3CrowdOracleLagForkTest is Test {
    uint256 internal constant U = 1e6;
    uint256 internal constant LAG_BPS = 49;
    uint256 internal constant ORDER = 400 * U; // three savers: a 1,200 USDG book

    MainnetBeta internal script;
    IPoolManager internal pm;
    address internal usdg;
    StockTokenRegistry internal registry;
    Valuer internal valuer;
    StockRouter internal router;
    JitterBeacon internal beacon;
    SavingsVault internal vault;
    CrowdBuy internal crowd;
    V4Pusher internal pusher;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    uint64 internal genesis;
    uint256 internal monday; // 00:00 UTC of the Monday the scenario runs on
    uint256 internal nonce;

    mapping(address token => MockFeed) internal feedOf;
    mapping(address token => PoolKey) internal keyOf;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc); // latest: the public RPC keeps ~15 min of history
        script = new MainnetBeta();
        pm = IPoolManager(script.POOL_MANAGER());
        usdg = script.USDG();

        // The next Monday that is a trading day (the fork may be taken on a weekend).
        uint256 day = block.timestamp / 1 days;
        uint256 ahead = (8 - (day + 4) % 7) % 7;
        if (ahead == 0) ahead = 7;
        monday = (day + ahead) * 1 days;
        registry = new StockTokenRegistry(address(this));
        valuer = new Valuer(registry, script.DEFAULT_MAX_STALENESS());
        valuer.enableMarketCalendar();
        valuer.closeDays(script.nyseClosedDays());
        valuer.earlyCloseDays(script.nyseEarlyCloses());
        valuer.setCalendarValidUntil(script.CALENDAR_VALID_UNTIL());
        while (valuer.closedDay(monday / 1 days)) monday += 7 days;
        genesis = uint64(monday - 1 days + script.CROWD_DAY_OFFSET()); // Sunday 19:30 UTC

        router = new StockRouter(pm, registry, valuer, IERC20Metadata(usdg), owner);
        MainnetBeta.Stock[] memory s = script.stocks();
        _list(s[8]); // SPY, fee 500
        _list(s[2]); // NVDA, fee 100
        beacon = new JitterBeacon(keeper, owner, script.BEACON_GRACE());
        vault = new SavingsVault(
            IERC20(usdg), script.PERMIT2(), ICanonicalRegistry(address(registry)), owner, keeper
        );
        crowd = new CrowdBuy(
            vault,
            router,
            IExecuteBeacon(address(beacon)),
            uint32(script.DEFAULT_MIN_CROWD()),
            script.CROWD_SLIPPAGE_BPS(),
            genesis,
            owner,
            keeper,
            script.CROWD_WINDOW()
        );
        vm.prank(owner);
        vault.setCrowd(address(crowd));
        pusher = new V4Pusher(pm);
    }

    function _list(MainnetBeta.Stock memory st) internal {
        MockFeed f = new MockFeed(8, 100e8, st.sym);
        feedOf[st.token] = f;
        registry.list(st.token, address(f), true);
        PoolKey memory key = script.poolKeyOf(st);
        keyOf[st.token] = key;
        vm.prank(owner);
        router.setPool(st.token, key);
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(address(pm)); // USDG is a proxy: take from the PoolManager's balance on the fork
        IERC20(usdg).transfer(to, amount);
    }

    function _join(address user, address asset, uint256 amount) internal {
        _fund(user, amount);
        vm.startPrank(user);
        vault.setSettings(SavingsVault.Settings(10, 1, uint64(500 * U), 0, 0));
        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](1);
        m[0] = SavingsVault.MixEntry(asset, 10_000);
        vault.setMix(m);
        IERC20(usdg).approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        uint256 left = amount;
        while (left != 0) {
            uint256 chunk = left < 10 * U - 1 ? left : 10 * U - 1;
            vm.prank(keeper);
            vault.accrue(user, bytes32(++nonce), 0, 10 * U - chunk);
            left -= chunk;
        }
        vm.prank(user);
        crowd.join(user);
    }

    // ---------------------------------------------------------------- pool price (USD per whole token, 1e18)

    function _sqrtP(PoolKey memory key) internal view returns (uint160) {
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(key)), V4Constants.POOLS_SLOT));
        return uint160(uint256(pm.extsload(slot)));
    }

    function _priceOf(PoolKey memory key) internal view returns (uint256) {
        uint256 sp = _sqrtP(key);
        if (key.currency0 == usdg) return Math.mulDiv(Math.mulDiv(1e30, 1 << 96, sp), 1 << 96, sp); // token1 per USDG
        return Math.mulDiv(Math.mulDiv(sp, sp, 1 << 96), 1e30, 1 << 96); // USDG per token0
    }

    function _sqrtFor(PoolKey memory key, uint256 price) internal view returns (uint160) {
        if (key.currency0 == usdg) return uint160(Math.sqrt(Math.mulDiv(1e30, 1 << 192, price)));
        return uint160(Math.sqrt(Math.mulDiv(price, 1 << 192, 1e30)));
    }

    /// Push the pool's price up to `T x (1e6 + ppm) / 1e6` by buying the stock token with USDG.
    function _pushUp(address asset, uint256 truth, uint256 ppm) internal {
        if (ppm == 0) return;
        PoolKey memory key = keyOf[asset];
        _fund(address(pusher), 2_000_000 * U);
        pusher.push(key, usdg, _sqrtFor(key, truth * (1e6 + ppm) / 1e6));
    }

    function _tryExecute(address asset) internal returns (bool ok) {
        vm.prank(stranger);
        try crowd.execute(asset) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ---------------------------------------------------------------- scenario

    /// Three savers join on Monday 12:00 UTC; the keeper never runs (dead), so the book is public from Monday 18:30
    /// (windowEnd - GRACE). A round lands at 18:35 at `answer`; the stranger acts at 18:45 (round 10 min old).
    function _setUpBook(address asset, uint256 answerE18) internal {
        vm.warp(monday + 12 hours);
        _join(makeAddr("saver0"), asset, ORDER);
        _join(makeAddr("saver1"), asset, ORDER);
        _join(makeAddr("saver2"), asset, ORDER);
        uint64 from = crowd.missedFrom(asset, crowd.book(asset, 0).crowdSince);
        assertEq(from, monday + 18 hours + 30 minutes);
        vm.warp(from + 5 minutes);
        feedOf[asset].set(int256(answerE18 / 1e10));
        vm.warp(from + 15 minutes);
        assertFalse(valuer.marketClosed());
    }

    struct Lag {
        uint256 truth; // pool mid = the real price (1e18 USD per token)
        uint256 oracle; // the round (1e18)
        uint256 lagPpm; // (oracle - truth) / oracle
        uint256 bandBps;
        uint256 boundPpm; // 1 - (1 - band)(1 - lag), rounded up
        uint256 supBoundPpm; // the same at lag = 50 bps
        uint256 pushPpm; // the stranger's best push above T
        uint256 lossPpm; // the book's loss against T
    }

    function _marketDownWorstCase(address asset) internal returns (Lag memory l) {
        l.truth = _priceOf(keyOf[asset]);
        uint256 answer8 = Math.mulDiv(l.truth, 10_000, (10_000 - LAG_BPS) * 1e10, Math.Rounding.Ceil);
        l.oracle = answer8 * 1e10;
        _setUpBook(asset, l.oracle);
        assertEq(valuer.quote(asset).priceUsdPerToken, l.oracle);
        l.lagPpm = (l.oracle - l.truth) * 1e6 / l.oracle;
        assertGe(l.lagPpm, LAG_BPS * 100);
        assertLt(l.lagPpm, 5_000, "under the 50 bps deviation: no new round");
        l.bandBps = crowd.publicSlippageBps(asset);
        l.boundPpm = 1e6 - Math.mulDiv(1e6 - l.bandBps * 100, 1e6 - l.lagPpm, 1e6);
        l.supBoundPpm = 1e6 - Math.mulDiv(1e6 - l.bandBps * 100, 1e6 - 5_000, 1e6);

        // Bisection over the push: the highest pool price at which the public execution still fills.
        uint256 snap = vm.snapshotState();
        uint256 lo;
        uint256 hi = (l.bandBps + LAG_BPS + 20) * 100;
        assertTrue(_tryExecute(asset), "unpushed: the book fills at T (it buys below the lagging oracle)");
        vm.revertToState(snap);
        _pushUp(asset, l.truth, hi);
        assertFalse(_tryExecute(asset), "a push past band + lag is refused");
        vm.revertToState(snap);
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            _pushUp(asset, l.truth, mid);
            if (_tryExecute(asset)) lo = mid;
            else hi = mid;
            vm.revertToState(snap);
        }
        l.pushPpm = lo;
        _pushUp(asset, l.truth, lo);
        assertTrue(_tryExecute(asset));
        CrowdBuy.Book memory b = crowd.book(asset, 0);
        assertTrue(b.executed);
        uint256 worth = Math.mulDiv(b.rawOut, l.truth, 1e30); // USDG units at the real price
        l.lossPpm = (b.usdgTotal - worth) * 1e6 / b.usdgTotal;

        emit log_named_uint("pool fee + 10 bps public band (bps)", l.bandBps);
        emit log_named_uint("oracle lag below the round (ppm)", l.lagPpm);
        emit log_named_uint("stranger's best push above the real price (ppm)", l.pushPpm);
        emit log_named_uint("book loss vs the real price (ppm, 100 = 1 bps)", l.lossPpm);
        emit log_named_uint("bound 1-(1-band)(1-lag) (ppm)", l.boundPpm);
        emit log_named_uint("bound at lag -> 50 bps (ppm)", l.supBoundPpm);

        assertLe(l.lossPpm, l.boundPpm + 1, "never more than band + lag (the router's oracle minOut)");
        assertGe(l.lossPpm + 50, l.boundPpm, "and the bound is reached (within 0.5 bps) by the stranger's push");
    }

    function test_V2L4_SPY_marketDown_worstCaseLossIsBandPlusLag() public {
        address spy = script.stocks()[8].token;
        Lag memory l = _marketDownWorstCase(spy);
        assertEq(l.bandBps, 15, "5 bps pool + 10");
        assertEq(l.supBoundPpm, 6_493, "64.925 bps, rounded up: the worst case on a 5 bps pool");
        // FINDING: above R3-ORC-1's "<= about 60 bps on 1-5 bps pools".
        assertGt(l.lossPpm, 6_000, "on the 5 bps SPY pool the real loss exceeds 60 bps");
        assertLe(l.lossPpm, 6_500);
    }

    function test_V2L4_NVDA_marketDown_worstCaseLossIsBandPlusLag() public {
        address nvda = script.stocks()[2].token;
        Lag memory l = _marketDownWorstCase(nvda);
        assertEq(l.bandBps, 11, "1 bps pool + 10");
        assertEq(l.supBoundPpm, 6_095, "60.945 bps, rounded up: the worst case on a 1 bps pool");
        assertLe(l.lossPpm, 6_100, "~60 bps on a 1 bps pool, as R3-ORC-1 says");
    }

    /// Market UP 49 bps since the round: the pool at the real price is 49 bps dearer than the oracle, more than the
    /// public band; the public fallback refuses (and pushing the pool further up only makes it worse).
    function test_V2L4_marketUp_publicFallbackRefuses() public {
        address[2] memory assets = [script.stocks()[8].token, script.stocks()[2].token];
        for (uint256 i; i < 2; i++) {
            address asset = assets[i];
            uint256 snap = vm.snapshotState();
            uint256 truth = _priceOf(keyOf[asset]);
            uint256 oracle = truth * 10_000 / (10_000 + LAG_BPS) / 1e10 * 1e10;
            _setUpBook(asset, oracle);
            vm.prank(stranger);
            vm.expectPartialRevert(StockRouter.Slippage.selector);
            crowd.execute(asset);
            assertFalse(crowd.book(asset, 0).executed);
            vm.revertToState(snap);
        }
    }
}
