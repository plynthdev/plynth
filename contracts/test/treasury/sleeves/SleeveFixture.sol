// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {StockTokenRegistry} from "../../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../../src/core/Valuer.sol";
import {StockRouter} from "../../../src/core/StockRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../../src/interfaces/IUniswapV4.sol";
import {MockFeed} from "../../../src/testnet/MockFeed.sol";
import {TreasuryPolicy} from "../../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../../src/treasury/PolicyGuard.sol";
import {BoardApprovals} from "../../../src/treasury/BoardApprovals.sol";
import {TreasuryAccount} from "../../../src/treasury/TreasuryAccount.sol";
import {CashSleeve} from "../../../src/treasury/sleeves/CashSleeve.sol";
import {EquitySleeve} from "../../../src/treasury/sleeves/EquitySleeve.sol";
import {MockERC20, MockPoolManager, MockStockERC20} from "../../mocks/MockV4.sol";
import {MockCashVault} from "../../mocks/TreasuryMocks.sol";

/// A treasury wired with the real CashSleeve (USDG + one ERC-4626 vault) and the real EquitySleeve (AAPL,
/// NVDA through the StockRouter on a fixed-rate MockPoolManager). Funded with 1,000,000 USDG.
/// AAPL: feed per SHARE ($200) with uiMultiplier 1.0017, so the token is worth $200.34. NVDA: $100, mult 1.
abstract contract SleeveFixture is Test {
    uint64 constant T0 = 1_800_000_000;
    bytes32 constant CASH_DESK = "cash";
    bytes32 constant EQUITY_DESK = "equity";
    uint256 constant FUNDING = 1_000_000e6;
    uint24 constant POOL_FEE = 500; // 0.05%
    uint16 constant MAX_LOSS_BPS = 200;
    uint16 constant SLIP = 100;

    address board = makeAddr("board");
    address controller = makeAddr("controller");
    address cashKey = makeAddr("cashKey");
    address eqKey = makeAddr("eqKey");

    MockERC20 usdg;
    MockStockERC20 aapl;
    MockStockERC20 nvda;
    MockStockERC20 thin; // supply 500: 1% float = 5 tokens = $500
    MockFeed aaplFeed;
    MockFeed nvdaFeed;
    StockTokenRegistry registry;
    Valuer valuer;
    MockPoolManager pm;
    StockRouter router;
    MockCashVault vault;
    TreasuryPolicy policy;
    PolicyGuard guard;
    BoardApprovals approvals;
    TreasuryAccount account;
    CashSleeve cash;
    EquitySleeve equity;

    bytes32[8] leaves;
    bytes32 root;

    function _policy() internal view virtual returns (TreasuryPolicy.Policy memory p) {
        p.cash = TreasuryPolicy.Band(0, 10_000);
        p.equity = TreasuryPolicy.Band(0, 10_000);
        p.perOrderCapUsd = 200_000;
        p.perDayCapUsd = 2_000_000;
        p.perNameFloatCapBps = 100; // 1% of supply
        p.noNewRiskOffHours = true;
        p.pauseNewRiskAtDrawdownBps = -400;
        p.deriskAtDrawdownBps = -800;
        p.approvalAboveUsd = 150_000;
        p.periodSeconds = 30 days;
        p.instrumentAllowRoot = root;
        p.controller = controller;
    }

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockERC20("USDG", 6);
        aapl = new MockStockERC20("AAPL", 18);
        nvda = new MockStockERC20("NVDA", 18);
        aapl.setMultiplier(1.0017e18);
        aaplFeed = new MockFeed(8, 200e8, "AAPL / USD per share");
        nvdaFeed = new MockFeed(8, 100e8, "NVDA / USD per share");
        registry = new StockTokenRegistry(address(this));
        registry.list(address(aapl), address(aaplFeed), false);
        registry.list(address(nvda), address(nvdaFeed), false);
        valuer = new Valuer(registry, 1 hours);

        pm = new MockPoolManager();
        router = new StockRouter(IPoolManager(address(pm)), registry, valuer, IERC20Metadata(address(usdg)), address(this));
        _setPool(address(aapl));
        _setPool(address(nvda));
        usdg.mint(address(pm), 1e9 * 1e6);
        aapl.mint(address(pm), 1_000_000e18); // supply 1M tokens: 1% float = 10,000 AAPL (~$2M)
        nvda.mint(address(pm), 1_000_000e18);
        thin = new MockStockERC20("THIN", 18);
        registry.list(address(thin), address(nvdaFeed), false);
        _setPool(address(thin));
        thin.mint(address(pm), 500e18);

        vault = new MockCashVault(IERC20(address(usdg)));
        _buildTree();
        policy = new TreasuryPolicy(board, _policy());
        guard = new PolicyGuard(registry, valuer, MAX_LOSS_BPS);
        approvals = new BoardApprovals(board, address(guard));
        account = new TreasuryAccount(board, policy, guard, address(approvals));

        IERC4626[] memory vs = new IERC4626[](1);
        vs[0] = IERC4626(address(vault));
        cash = new CashSleeve(valuer, IERC20(address(usdg)), vs);
        address[] memory toks = new address[](3);
        toks[0] = address(aapl);
        toks[1] = address(nvda);
        toks[2] = address(thin);
        equity = new EquitySleeve(router, toks);

        vm.startPrank(board);
        approvals.bindAccount(address(account));
        account.registerDesk(CASH_DESK, cashKey, _one(address(cash)));
        account.registerDesk(EQUITY_DESK, eqKey, _one(address(equity)));
        vm.stopPrank();

        usdg.mint(address(account), FUNDING);
    }

    // ------------------------------------------------------------ pools

    function _setPool(address token) internal {
        (address c0, address c1) = address(usdg) < token ? (address(usdg), token) : (token, address(usdg));
        PoolKey memory key = PoolKey(c0, c1, POOL_FEE, 10, IHooks(address(0)));
        router.setPool(token, key);
        _setPoolPrice(token, valuer.quote(token).priceUsdPerToken);
    }

    /// Pool exchange rate equal to `usdPerToken` (1e18) for the 6dp USDG / 18dp token pair.
    function _setPoolPrice(address token, uint256 usdPerToken) internal {
        PoolKey memory key = router.poolOf(token);
        if (key.currency0 == address(usdg)) pm.setRate(key, 1e18 * 1e18 * 1e18 / (usdPerToken * 1e6));
        else pm.setRate(key, usdPerToken * 1e6 / 1e18);
    }

    // ------------------------------------------------------------ merkle (8 leaves, 5 used)

    function _buildTree() internal {
        leaves[0] = keccak256(abi.encode(address(usdg), uint8(0)));
        leaves[1] = keccak256(abi.encode(address(vault), uint8(1)));
        leaves[2] = keccak256(abi.encode(address(aapl), uint8(2)));
        leaves[3] = keccak256(abi.encode(address(nvda), uint8(2)));
        leaves[4] = keccak256(abi.encode(address(thin), uint8(2)));
        leaves[5] = keccak256("pad5");
        leaves[6] = keccak256("pad6");
        leaves[7] = keccak256("pad7");
        root = Hashes.commutativeKeccak256(_layer2(0), _layer2(1));
    }

    function _layer1(uint256 i) internal view returns (bytes32) {
        return Hashes.commutativeKeccak256(leaves[2 * i], leaves[2 * i + 1]);
    }

    function _layer2(uint256 i) internal view returns (bytes32) {
        return Hashes.commutativeKeccak256(_layer1(2 * i), _layer1(2 * i + 1));
    }

    function _leafIndex(address asset) internal view returns (uint256) {
        if (asset == address(usdg)) return 0;
        if (asset == address(vault)) return 1;
        if (asset == address(aapl)) return 2;
        if (asset == address(nvda)) return 3;
        if (asset == address(thin)) return 4;
        return 5; // padding: never proves a real asset
    }

    /// Packed allowProof (length prefix + 3 siblings) for one increased asset.
    function _allow(address asset) internal view returns (bytes32[] memory out) {
        uint256 idx = _leafIndex(asset);
        out = new bytes32[](4);
        out[0] = bytes32(uint256(3));
        out[1] = leaves[idx ^ 1];
        out[2] = _layer1((idx / 2) ^ 1);
        out[3] = _layer2((idx / 4) ^ 1);
    }

    // ------------------------------------------------------------ ops

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _wrap(address pullToken, uint256 pullAmount, bytes memory runData) internal pure returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(pullToken, pullAmount);
        return abi.encode(pulls, runData);
    }

    function _buyData(address token, uint256 usdgIn, uint16 slip) internal view returns (bytes memory) {
        return _wrap(address(usdg), usdgIn, abi.encode(uint8(0), token, usdgIn, slip));
    }

    function _sellData(address token, uint256 raw, uint16 slip) internal pure returns (bytes memory) {
        return _wrap(token, raw, abi.encode(uint8(1), token, raw, slip));
    }

    function _depositData(uint256 amount, uint256 minShares) internal view returns (bytes memory) {
        return _wrap(address(usdg), amount, abi.encode(uint8(0), address(vault), amount, minShares));
    }

    function _redeemData(uint256 shares, uint256 minAssets) internal view returns (bytes memory) {
        return _wrap(address(vault), shares, abi.encode(uint8(1), address(vault), shares, minAssets));
    }

    function _buy(address token, uint256 usdgIn) internal returns (uint256 out) {
        vm.prank(eqKey);
        out = abi.decode(account.execute(EQUITY_DESK, address(equity), _buyData(token, usdgIn, SLIP), _allow(token), 0), (uint256));
    }

    function _sell(address token, uint256 raw) internal returns (uint256 out) {
        vm.prank(eqKey);
        out = abi.decode(account.execute(EQUITY_DESK, address(equity), _sellData(token, raw, SLIP), _allow(address(usdg)), 0), (uint256));
    }

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        vm.prank(cashKey);
        shares = abi.decode(account.execute(CASH_DESK, address(cash), _depositData(amount, 0), _allow(address(vault)), 0), (uint256));
    }

    function _redeem(uint256 shares) internal returns (uint256 assets) {
        vm.prank(cashKey);
        assets = abi.decode(account.execute(CASH_DESK, address(cash), _redeemData(shares, 0), _allow(address(usdg)), 0), (uint256));
    }

    function _expectCode(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.GuardRejected.selector, code));
    }

    function _assertSleevesEmpty() internal view {
        assertEq(usdg.balanceOf(address(cash)), 0, "cash sleeve usdg");
        assertEq(vault.balanceOf(address(cash)), 0, "cash sleeve shares");
        assertEq(usdg.balanceOf(address(equity)), 0, "equity sleeve usdg");
        assertEq(aapl.balanceOf(address(equity)), 0, "equity sleeve aapl");
        assertEq(nvda.balanceOf(address(equity)), 0, "equity sleeve nvda");
        assertEq(thin.balanceOf(address(equity)), 0, "equity sleeve thin");
        assertEq(usdg.allowance(address(account), address(cash)), 0, "allowance cash");
        assertEq(usdg.allowance(address(account), address(equity)), 0, "allowance equity");
        assertEq(usdg.allowance(address(equity), address(router)), 0, "allowance router");
    }
}
