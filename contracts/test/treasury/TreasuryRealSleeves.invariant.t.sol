// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {CashSleeve} from "../../src/treasury/sleeves/CashSleeve.sol";
import {EquitySleeve} from "../../src/treasury/sleeves/EquitySleeve.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockERC20, MockPoolManager, MockStockERC20} from "../mocks/MockV4.sol";
import {MockCashVault} from "../mocks/TreasuryMocks.sol";
import {SleeveFixture} from "./sleeves/SleeveFixture.sol";

/// TreasuryInvariant's desk properties, but through the REAL CashSleeve (an ERC-4626 vault) and the REAL
/// EquitySleeve (StockRouter on a fixed-rate v4 pool manager), with oracle moves, pools that drift off the
/// oracle, stale feeds (off-hours), vault yield and desk-chosen slippage. After every successful execute it
/// checks, independently of the guard's code: each band holds or moved strictly toward it from the same side;
/// the trailing-24h notional stays under the day cap and each op under the order cap; NAV lost in the op is at
/// most maxOpLossBps of its notional (the guard's rule 5-6 loss bound); and the stateless sleeves keep nothing.
contract RealDeskHandler is Test {
    struct Rec {
        uint256 ts;
        uint256 notional;
    }

    bytes32 constant CASH_DESK = "cash";
    bytes32 constant EQUITY_DESK = "equity";
    uint256 constant DAY_CAP = 250_000e18;
    uint256 constant ORDER_CAP = 100_000e18;
    uint256 constant CASH_LO = 0.4e18;
    uint256 constant CASH_HI = 0.7e18;
    uint256 constant EQ_LO = 0.3e18;
    uint256 constant EQ_HI = 0.6e18;
    uint256 constant BPS = 10_000;

    TreasuryAccount immutable account;
    PolicyGuard immutable guard;
    CashSleeve immutable cash;
    EquitySleeve immutable equity;
    StockRouter immutable stockRouter;
    Valuer immutable valuer;
    MockPoolManager immutable pm;
    MockERC20 immutable usdg;
    MockCashVault immutable vault;
    MockStockERC20[2] tokens;
    MockFeed[2] feeds;
    int256[2] basePrices;
    address immutable eqKey;
    address immutable cashKey;
    mapping(address => bytes32[]) proofs;

    Rec[] public recs;
    uint256 public successes;
    uint256 public rejections;
    uint256 public buys;
    uint256 public sells;
    uint256 public deposits;
    uint256 public redeems;
    uint256 public maxLossBpsSeen; // worst NAV loss of a success, in bps of its notional
    bool public bandViolated;
    bool public dayCapViolated;
    bool public orderCapViolated;
    bool public navLossViolated;
    bool public sleeveKeptSomething;

    constructor(
        TreasuryAccount account_,
        CashSleeve cash_,
        EquitySleeve equity_,
        MockPoolManager pm_,
        MockCashVault vault_,
        MockStockERC20[2] memory tokens_,
        MockFeed[2] memory feeds_,
        address eqKey_,
        address cashKey_,
        bytes32[][4] memory proofs_
    ) {
        account = account_;
        guard = account_.guard();
        cash = cash_;
        equity = equity_;
        stockRouter = equity_.router();
        valuer = equity_.valuer();
        pm = pm_;
        usdg = MockERC20(address(cash_.usdg()));
        vault = vault_;
        tokens = tokens_;
        feeds = feeds_;
        (, basePrices[0],,,) = feeds_[0].latestRoundData();
        (, basePrices[1],,,) = feeds_[1].latestRoundData();
        eqKey = eqKey_;
        cashKey = cashKey_;
        proofs[address(usdg)] = proofs_[0];
        proofs[address(vault)] = proofs_[1];
        proofs[address(tokens_[0])] = proofs_[2];
        proofs[address(tokens_[1])] = proofs_[3];
    }

    // ------------------------------------------------------------ desk actions

    /// slippage 0..250 bps: above the guard's 200 the sleeve itself must refuse.
    function buy(uint256 seed, uint256 amount, uint16 slip) external {
        MockStockERC20 t = tokens[seed % 2];
        amount = bound(amount, 1e6, 60_000e6);
        if (amount > usdg.balanceOf(address(account))) return;
        slip = uint16(bound(slip, 0, 250));
        _exec(eqKey, EQUITY_DESK, address(equity), address(usdg), amount, abi.encode(uint8(0), address(t), amount, slip), address(t));
    }

    function sell(uint256 seed, uint256 pct, uint16 slip) external {
        MockStockERC20 t = tokens[seed % 2];
        uint256 raw = t.balanceOf(address(account)) * bound(pct, 1, 100) / 100;
        if (raw == 0) return;
        slip = uint16(bound(slip, 0, 250));
        _exec(eqKey, EQUITY_DESK, address(equity), address(t), raw, abi.encode(uint8(1), address(t), raw, slip), address(usdg));
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1e6, 60_000e6);
        if (amount > usdg.balanceOf(address(account))) return;
        _exec(cashKey, CASH_DESK, address(cash), address(usdg), amount, abi.encode(uint8(0), address(vault), amount, uint256(0)), address(vault));
    }

    function redeem(uint256 pct) external {
        uint256 shares = vault.balanceOf(address(account)) * bound(pct, 1, 100) / 100;
        if (shares == 0) return;
        _exec(cashKey, CASH_DESK, address(cash), address(vault), shares, abi.encode(uint8(1), address(vault), shares, uint256(0)), address(usdg));
    }

    // ------------------------------------------------------------ market

    /// Oracle moves within +-15% of the start price; the pool follows the oracle exactly.
    function moveOracle(uint256 seed, uint256 bps) external {
        uint256 i = seed % 2;
        feeds[i].set(basePrices[i] * int256(bound(bps, 8_500, 11_500)) / int256(BPS));
        _setPoolPrice(address(tokens[i]), valuer.quote(address(tokens[i])).priceUsdPerToken);
    }

    /// The pool drifts up to +-3% off the oracle: the router's oracle-bounded slippage and the guard's loss
    /// bound both get tested against a real fill.
    function driftPool(uint256 seed, uint256 bps) external {
        uint256 i = seed % 2;
        uint256 px = valuer.quote(address(tokens[i])).priceUsdPerToken * bound(bps, 9_700, 10_300) / BPS;
        _setPoolPrice(address(tokens[i]), px);
    }

    /// Yield on the cash vault (USDG donated to it): NAV moves between ops, never inside one.
    function vaultYield(uint256 amount) external {
        usdg.mint(address(vault), bound(amount, 0, 5_000e6));
    }

    function warp(uint256 secs, bool freshFeeds) external {
        vm.warp(block.timestamp + bound(secs, 0, 30 hours));
        if (freshFeeds) {
            feeds[0].setUpdatedAt(block.timestamp);
            feeds[1].setUpdatedAt(block.timestamp);
        }
    }

    // ------------------------------------------------------------ core

    function _exec(
        address key,
        bytes32 deskId,
        address adapter,
        address pullToken,
        uint256 pullAmount,
        bytes memory runData,
        address increased
    ) internal {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(pullToken, pullAmount);
        bytes memory data = abi.encode(pulls, runData);
        PolicyGuard.Snapshot memory b = guard.snapshot(address(account));

        vm.prank(key);
        try account.execute(deskId, adapter, data, proofs[increased], 0) {
            ++successes;
            bool usdgIn = pullToken == address(usdg);
            if (deskId == EQUITY_DESK) {
                if (usdgIn) ++buys;
                else ++sells;
            } else if (usdgIn) {
                ++deposits;
            } else {
                ++redeems;
            }
            PolicyGuard.Snapshot memory a = guard.snapshot(address(account));
            _checkBands(b, a);
            uint256 notional = _recordAndCheckDay(b, a);
            _checkNavLoss(b, a, notional);
        } catch {
            ++rejections;
        }
        _checkSleevesEmpty();
    }

    function _checkBands(PolicyGuard.Snapshot memory b, PolicyGuard.Snapshot memory a) internal {
        if (a.nav == 0) return;
        if (!_ok(CASH_LO, CASH_HI, b.cashUsd * 1e18 / b.nav, a.cashUsd * 1e18 / a.nav)) bandViolated = true;
        if (!_ok(EQ_LO, EQ_HI, b.equityUsd * 1e18 / b.nav, a.equityUsd * 1e18 / a.nav)) bandViolated = true;
    }

    function _ok(uint256 lo, uint256 hi, uint256 wb, uint256 wa) internal pure returns (bool) {
        if (wa >= lo && wa <= hi) return true;
        if (wa < lo) return wb < wa;
        return wb > wa;
    }

    function _recordAndCheckDay(PolicyGuard.Snapshot memory b, PolicyGuard.Snapshot memory a)
        internal
        returns (uint256 notional)
    {
        uint256 moved;
        for (uint256 i; i < a.usd.length; ++i) {
            moved += a.usd[i] > b.usd[i] ? a.usd[i] - b.usd[i] : b.usd[i] - a.usd[i];
        }
        notional = moved / 2;
        if (notional > ORDER_CAP) orderCapViolated = true;
        recs.push(Rec(block.timestamp, notional));
        uint256 sum;
        for (uint256 i = recs.length; i > 0; --i) {
            if (recs[i - 1].ts + 24 hours <= block.timestamp) break; // recs are in time order
            sum += recs[i - 1].notional;
        }
        if (sum > DAY_CAP) dayCapViolated = true;
    }

    /// Value may leave the account inside an op only as bounded fees/slippage: loss <= notional x maxOpLossBps.
    function _checkNavLoss(PolicyGuard.Snapshot memory b, PolicyGuard.Snapshot memory a, uint256 notional)
        internal
    {
        if (a.nav >= b.nav) return;
        uint256 loss = b.nav - a.nav;
        if (loss > notional * guard.maxOpLossBps() / BPS) navLossViolated = true;
        if (notional != 0) {
            uint256 lb = loss * BPS / notional;
            if (lb > maxLossBpsSeen) maxLossBpsSeen = lb;
        }
    }

    function _checkSleevesEmpty() internal {
        if (usdg.balanceOf(address(cash)) != 0 || vault.balanceOf(address(cash)) != 0) sleeveKeptSomething = true;
        if (usdg.balanceOf(address(equity)) != 0) sleeveKeptSomething = true;
        if (tokens[0].balanceOf(address(equity)) != 0 || tokens[1].balanceOf(address(equity)) != 0) {
            sleeveKeptSomething = true;
        }
        if (usdg.allowance(address(account), address(cash)) != 0) sleeveKeptSomething = true;
        if (usdg.allowance(address(account), address(equity)) != 0) sleeveKeptSomething = true;
        if (vault.allowance(address(account), address(cash)) != 0) sleeveKeptSomething = true;
        if (usdg.allowance(address(equity), address(stockRouter)) != 0) sleeveKeptSomething = true;
    }

    /// Pool exchange rate equal to `usdPerToken` (1e18) for the 6dp USDG / 18dp token pair (as SleeveFixture).
    function _setPoolPrice(address token, uint256 usdPerToken) internal {
        PoolKey memory key = stockRouter.poolOf(token);
        if (key.currency0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (usdPerToken * 1e6));
        else pm.setRate(key, usdPerToken * 1e6 / 1e18);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 60
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 500
contract TreasuryRealSleevesInvariantTest is SleeveFixture {
    RealDeskHandler handler;

    /// TreasuryInvariant's policy (bands 40-70% cash / 30-60% equity, $100k order cap, $250k day cap,
    /// tickets above $50k) on top of the real-sleeve fixture.
    function _policy() internal view override returns (TreasuryPolicy.Policy memory p) {
        p = super._policy();
        p.cash = TreasuryPolicy.Band(4000, 7000);
        p.equity = TreasuryPolicy.Band(3000, 6000);
        p.perOrderCapUsd = 100_000;
        p.perDayCapUsd = 250_000;
        p.approvalAboveUsd = 50_000;
    }

    function setUp() public override {
        super.setUp();
        // Start out of band: $1M USDG + 2,000 AAPL (~$400k): cash ~71%, equity ~29%.
        aapl.mint(address(account), 2000e18);
        bytes32[][4] memory ps = [_allow(address(usdg)), _allow(address(vault)), _allow(address(aapl)), _allow(address(nvda))];
        handler = new RealDeskHandler(
            account, cash, equity, pm, vault, [aapl, nvda], [aaplFeed, nvdaFeed], eqKey, cashKey, ps
        );
        aaplFeed.transferOwnership(address(handler));
        nvdaFeed.transferOwnership(address(handler));

        bytes4[] memory sels = new bytes4[](10);
        sels[0] = RealDeskHandler.buy.selector;
        sels[1] = RealDeskHandler.sell.selector;
        sels[2] = RealDeskHandler.deposit.selector;
        sels[3] = RealDeskHandler.redeem.selector;
        sels[4] = RealDeskHandler.moveOracle.selector;
        sels[5] = RealDeskHandler.driftPool.selector;
        sels[6] = RealDeskHandler.vaultYield.selector;
        sels[7] = RealDeskHandler.warp.selector;
        sels[8] = RealDeskHandler.buy.selector; // buys and sells twice as likely as market moves
        sels[9] = RealDeskHandler.sell.selector;
        targetSelector(FuzzSelector(address(handler), sels));
        targetContract(address(handler));
    }

    function invariant_bandsHoldOrImproveAfterEverySuccess() public view {
        assertFalse(handler.bandViolated());
    }

    function invariant_dayAndOrderCapsNeverExceeded() public view {
        assertFalse(handler.dayCapViolated(), "day cap");
        assertFalse(handler.orderCapViolated(), "order cap");
    }

    /// The guard's loss bound, checked from outside: NAV lost in any successful op <= maxOpLossBps x notional.
    function invariant_navLossPerOpBounded() public view {
        assertFalse(handler.navLossViolated());
    }

    /// The real sleeves are stateless: no balance, share or allowance is ever left behind.
    function invariant_sleevesKeepNothing() public view {
        assertFalse(handler.sleeveKeptSomething());
    }

    /// The board can always take everything out: USDG, vault shares and every Stock Token.
    function invariant_boardCanAlwaysWithdraw() public {
        uint256 s = vm.snapshotState();
        address[4] memory toks = [address(usdg), address(vault), address(aapl), address(nvda)];
        for (uint256 i; i < 4; ++i) {
            uint256 bal = IERC20(toks[i]).balanceOf(address(account));
            vm.prank(board);
            account.withdrawToBoard(toks[i], bal);
            assertEq(IERC20(toks[i]).balanceOf(address(account)), 0);
        }
        vm.revertToState(s);
    }

    function afterInvariant() public view {
        console2.log("successes", handler.successes(), "rejections", handler.rejections());
        console2.log("buys", handler.buys(), "sells", handler.sells());
        console2.log("deposits", handler.deposits(), "redeems", handler.redeems());
        console2.log("max NAV loss bps of notional", handler.maxLossBpsSeen());
    }

    /// Every desk path succeeds at least once through the real sleeves.
    function test_handlerReachesEveryPath() public {
        handler.buy(1, 40_000e6, 100); // NVDA
        handler.deposit(40_000e6);
        handler.warp(25 hours, true);
        handler.redeem(50);
        handler.driftPool(1, 10_100); // NVDA pool 1% rich: selling into it is fine
        handler.sell(1, 25, 100); // ~$10k: cash stays inside its band
        assertEq(handler.buys(), 1);
        assertEq(handler.deposits(), 1);
        assertEq(handler.redeems(), 1);
        assertEq(handler.sells(), 1);
        assertFalse(handler.bandViolated());
        assertFalse(handler.navLossViolated());
        assertFalse(handler.sleeveKeptSomething());
    }
}
