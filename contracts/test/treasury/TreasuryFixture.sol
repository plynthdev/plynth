// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {
    MockCashVault, MockCashSleeve, MockEquitySleeve, MockPeriodClose
} from "../mocks/TreasuryMocks.sol";

/// A treasury with a cash sleeve (USDG + an ERC-4626 vault) and an equity sleeve (AAPL, NVDA, DEL, BAD),
/// funded with 600,000 USDG and 2,000 AAPL ($1M NAV, cash 60%, equity 40%: inside both bands). Tracked asset order: USDG, VAULT, AAPL, NVDA, DEL, BAD.
/// The policy allows USDG, VAULT, AAPL, NVDA and DEL; DEL is delisted in the registry; BAD is canonical but
/// not allowed by the policy.
abstract contract TreasuryFixture is Test {
    uint64 constant T0 = 1_800_000_000;
    bytes32 constant CASH_DESK = "cash";
    bytes32 constant EQUITY_DESK = "equity";
    uint256 constant FUNDING = 600_000e6;
    uint256 constant SEED_AAPL = 2000e18; // $400k at $200: NAV $1M, cash 60%, equity 40%

    address board = makeAddr("board");
    address controller = makeAddr("controller");
    address cashKey = makeAddr("cashKey");
    address eqKey = makeAddr("eqKey");
    address stranger = makeAddr("stranger");

    MockUSDG usdg;
    MockStockToken aapl;
    /// The guard's maxOpLossBps (a test may lower it before setUp, e.g. to the v2 mainnet 50).
    uint16 guardLossBps = 200;
    MockStockToken nvda;
    MockStockToken del;
    MockStockToken bad;
    MockFeed aaplFeed;
    MockFeed nvdaFeed;
    MockFeed delFeed;
    MockFeed badFeed;
    StockTokenRegistry registry;
    Valuer valuer;
    TreasuryPolicy policy;
    PolicyGuard guard;
    BoardApprovals approvals;
    TreasuryAccount account;
    MockCashVault vault;
    MockCashSleeve cashSleeve;
    MockEquitySleeve eqSleeve;
    MockPeriodClose periodClose;

    bytes32[8] leaves;
    bytes32 root;

    function _policy() internal view returns (TreasuryPolicy.Policy memory p) {
        p.cash = TreasuryPolicy.Band(4000, 7000);
        p.equity = TreasuryPolicy.Band(3000, 6000);
        p.perOrderCapUsd = 100_000;
        p.perDayCapUsd = 250_000;
        p.perNameFloatCapBps = 100;
        p.noNewRiskOffHours = true;
        p.pauseNewRiskAtDrawdownBps = -400;
        p.deriskAtDrawdownBps = -800;
        p.approvalAboveUsd = 50_000;
        p.periodSeconds = 30 days;
        p.instrumentAllowRoot = root;
        p.controller = controller;
    }

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockUSDG();
        aapl = new MockStockToken("AAPL", "AAPL");
        nvda = new MockStockToken("NVDA", "NVDA");
        del = new MockStockToken("DEL", "DEL");
        bad = new MockStockToken("BAD", "BAD");
        aaplFeed = new MockFeed(8, 200e8, "AAPL / USD");
        nvdaFeed = new MockFeed(8, 100e8, "NVDA / USD");
        delFeed = new MockFeed(8, 50e8, "DEL / USD");
        badFeed = new MockFeed(8, 10e8, "BAD / USD");

        registry = new StockTokenRegistry(address(this));
        registry.list(address(aapl), address(aaplFeed), true);
        registry.list(address(nvda), address(nvdaFeed), true);
        registry.list(address(del), address(delFeed), true);
        registry.list(address(bad), address(badFeed), true);
        registry.delist(address(del));
        valuer = new Valuer(registry, 1 hours);

        vault = new MockCashVault(usdg);
        _buildTree();

        policy = new TreasuryPolicy(board, _policy(), 48 hours);
        guard = new PolicyGuard(registry, valuer, guardLossBps);
        approvals = new BoardApprovals(board, address(guard));
        account = new TreasuryAccount(board, policy, guard, address(approvals));
        periodClose = new MockPeriodClose();

        cashSleeve = new MockCashSleeve(valuer, usdg, vault);
        address[] memory toks = new address[](4);
        toks[0] = address(aapl);
        toks[1] = address(nvda);
        toks[2] = address(del);
        toks[3] = address(bad);
        eqSleeve = new MockEquitySleeve(valuer, usdg, toks);

        vm.startPrank(board);
        approvals.bindAccount(address(account));
        account.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve)));
        account.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        if (_wireMockPeriodClose()) account.setPeriodClose(address(periodClose));
        vm.stopPrank();

        usdg.mint(address(account), FUNDING);
        aapl.mint(address(account), SEED_AAPL);
        usdg.mint(address(eqSleeve), 1e9 * 1e6);
        aapl.mint(address(eqSleeve), 1e30);
        nvda.mint(address(eqSleeve), 1e30);
        del.mint(address(eqSleeve), 1e30);
        bad.mint(address(eqSleeve), 1e30);
    }

    /// Suites that wire a real PeriodClose in their own setUp return false (the account's PeriodClose is set once
    /// instantly; replacing it waits the policy TIMELOCK).
    function _wireMockPeriodClose() internal virtual returns (bool) {
        return true;
    }

    /// Replaces `acc`'s PeriodClose through the timelock (propose, warp TIMELOCK, apply).
    function _replacePeriodClose(TreasuryAccount acc, address pc) internal {
        vm.prank(acc.board());
        acc.proposePeriodClose(pc);
        _warp(block.timestamp + acc.policy().TIMELOCK());
        acc.applyPeriodClose();
    }

    // ------------------------------------------------------------ merkle

    function _buildTree() internal {
        leaves[0] = keccak256(abi.encode(address(usdg), uint8(0)));
        leaves[1] = keccak256(abi.encode(address(vault), uint8(1)));
        leaves[2] = keccak256(abi.encode(address(aapl), uint8(2)));
        leaves[3] = keccak256(abi.encode(address(nvda), uint8(2)));
        leaves[4] = keccak256(abi.encode(address(del), uint8(2)));
        leaves[5] = keccak256("pad5");
        leaves[6] = keccak256("pad6");
        leaves[7] = keccak256("pad7");
        bytes32[4] memory l1;
        for (uint256 i; i < 4; ++i) {
            l1[i] = Hashes.commutativeKeccak256(leaves[2 * i], leaves[2 * i + 1]);
        }
        root = Hashes.commutativeKeccak256(
            Hashes.commutativeKeccak256(l1[0], l1[1]), Hashes.commutativeKeccak256(l1[2], l1[3])
        );
    }

    /// Proof for leaf `idx` (0..7) of the 8-leaf tree.
    function _merkleProof(uint256 idx) internal view returns (bytes32[] memory p) {
        bytes32[4] memory l1;
        for (uint256 i; i < 4; ++i) {
            l1[i] = Hashes.commutativeKeccak256(leaves[2 * i], leaves[2 * i + 1]);
        }
        bytes32[2] memory l2 =
            [Hashes.commutativeKeccak256(l1[0], l1[1]), Hashes.commutativeKeccak256(l1[2], l1[3])];
        p = new bytes32[](3);
        p[0] = leaves[idx ^ 1];
        p[1] = l1[(idx / 2) ^ 1];
        p[2] = l2[(idx / 4) ^ 1];
    }

    function _leafIndex(address asset) internal view returns (uint256) {
        if (asset == address(usdg)) return 0;
        if (asset == address(vault)) return 1;
        if (asset == address(aapl)) return 2;
        if (asset == address(nvda)) return 3;
        if (asset == address(del)) return 4;
        return 5; // a padding leaf: never proves a real asset
    }

    /// Packed allowProof for one increased asset.
    function _allow(address asset) internal view returns (bytes32[] memory out) {
        bytes32[] memory p = _merkleProof(_leafIndex(asset));
        out = new bytes32[](p.length + 1);
        out[0] = bytes32(p.length);
        for (uint256 i; i < p.length; ++i) out[i + 1] = p[i];
    }

    // ------------------------------------------------------------ ops

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _data(address pullToken, uint256 pullAmount, uint8 op, address a, uint256 b)
        internal
        pure
        returns (bytes memory)
    {
        TreasuryAccount.Pull[] memory pulls;
        if (pullToken != address(0)) {
            pulls = new TreasuryAccount.Pull[](1);
            pulls[0] = TreasuryAccount.Pull(pullToken, pullAmount);
        }
        return abi.encode(pulls, abi.encode(op, a, b));
    }

    function _buyData(address token, uint256 usdgIn) internal view returns (bytes memory) {
        return _data(address(usdg), usdgIn, 0, token, usdgIn);
    }

    function _sellData(address token, uint256 raw) internal pure returns (bytes memory) {
        return _data(token, raw, 1, token, raw);
    }

    function _buy(address token, uint256 usdgIn) internal {
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), _buyData(token, usdgIn), _allow(token), 0);
    }

    function _sell(address token, uint256 raw) internal {
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(eqSleeve), _sellData(token, raw), _allow(address(usdg)), 0);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(cashKey);
        account.execute(
            CASH_DESK, address(cashSleeve), _data(address(usdg), amount, 0, address(0), amount), _allow(address(vault)), 0
        );
    }

    function _expectCode(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.GuardRejected.selector, code));
    }

    /// Warps and keeps every feed fresh (as if markets were open).
    function _warp(uint256 t) internal {
        vm.warp(t);
        aaplFeed.setUpdatedAt(t);
        nvdaFeed.setUpdatedAt(t);
        delFeed.setUpdatedAt(t);
        badFeed.setUpdatedAt(t);
    }

    function _nav() internal view returns (uint256) {
        return guard.snapshot(address(account)).nav;
    }
}
