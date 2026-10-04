// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {BoardApprovals} from "../../src/treasury/BoardApprovals.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {CashSleeve} from "../../src/treasury/sleeves/CashSleeve.sol";
import {EquitySleeve} from "../../src/treasury/sleeves/EquitySleeve.sol";

/// Both sleeves inside a TreasuryAccount against real mainnet state on a fork: the Steakhouse USDG
/// Vault V2 (ERC-4626) and the default hookless USDG/AAPL v4 pool. Skips when RHC_MAINNET_RPC_URL is unset.
contract SleevesForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant STEAK_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    address board = makeAddr("board");
    address cashKey = makeAddr("cashKey");
    address eqKey = makeAddr("eqKey");
    TreasuryAccount account;
    PolicyGuard guard;
    CashSleeve cash;
    EquitySleeve equity;
    bytes32[4] leaves;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        StockTokenRegistry reg = new StockTokenRegistry(board);
        Valuer valuer = new Valuer(reg, 7 days); // feeds do not update off-hours
        vm.prank(board);
        reg.list(AAPL, AAPL_FEED, true);
        StockRouter router = new StockRouter(IPoolManager(POOL_MANAGER), reg, valuer, IERC20Metadata(USDG), board);
        vm.prank(board);
        router.setPool(AAPL, PoolKey(USDG, AAPL, 3000, 60, IHooks(address(0))));

        leaves[0] = keccak256(abi.encode(USDG, uint8(0)));
        leaves[1] = keccak256(abi.encode(STEAK_USDG, uint8(1)));
        leaves[2] = keccak256(abi.encode(AAPL, uint8(2)));
        leaves[3] = keccak256("pad");
        TreasuryPolicy.Policy memory p;
        p.cash = TreasuryPolicy.Band(0, 10_000);
        p.equity = TreasuryPolicy.Band(0, 10_000);
        p.perOrderCapUsd = 100_000;
        p.perDayCapUsd = 500_000;
        p.perNameFloatCapBps = 100;
        p.pauseNewRiskAtDrawdownBps = -400;
        p.deriskAtDrawdownBps = -800;
        p.approvalAboveUsd = 50_000;
        p.periodSeconds = 30 days;
        p.instrumentAllowRoot = Hashes.commutativeKeccak256(
            Hashes.commutativeKeccak256(leaves[0], leaves[1]), Hashes.commutativeKeccak256(leaves[2], leaves[3])
        );
        p.controller = board;

        TreasuryPolicy policy = new TreasuryPolicy(board, p);
        guard = new PolicyGuard(reg, valuer, 200);
        BoardApprovals approvals = new BoardApprovals(board, address(guard));
        account = new TreasuryAccount(board, policy, guard, address(approvals));
        IERC4626[] memory vs = new IERC4626[](1);
        vs[0] = IERC4626(STEAK_USDG);
        cash = new CashSleeve(valuer, IERC20(USDG), vs);
        address[] memory toks = new address[](1);
        toks[0] = AAPL;
        equity = new EquitySleeve(router, toks);
        vm.startPrank(board);
        approvals.bindAccount(address(account));
        account.registerDesk("cash", cashKey, _one(address(cash)));
        account.registerDesk("equity", eqKey, _one(address(equity)));
        vm.stopPrank();

        vm.prank(POOL_MANAGER); // holds every pool's USDG on the fork
        IERC20(USDG).transfer(address(account), 10_000e6);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _allow(uint256 idx) internal view returns (bytes32[] memory out) {
        out = new bytes32[](3);
        out[0] = bytes32(uint256(2));
        out[1] = leaves[idx ^ 1];
        out[2] = idx < 2
            ? Hashes.commutativeKeccak256(leaves[2], leaves[3])
            : Hashes.commutativeKeccak256(leaves[0], leaves[1]);
    }

    function _wrap(address token, uint256 amount, bytes memory runData) internal pure returns (bytes memory) {
        TreasuryAccount.Pull[] memory pulls = new TreasuryAccount.Pull[](1);
        pulls[0] = TreasuryAccount.Pull(token, amount);
        return abi.encode(pulls, runData);
    }

    function test_fork_cashSleeveDepositsAndRedeemsSteakUsdg() public {
        vm.prank(cashKey);
        account.execute("cash", address(cash), _wrap(USDG, 5_000e6, abi.encode(uint8(0), STEAK_USDG, uint256(5_000e6), uint256(1))), _allow(1), 0);
        uint256 shares = IERC20(STEAK_USDG).balanceOf(address(account));
        assertGt(shares, 0);
        (uint256 usd,) = cash.valueOf(address(account));
        assertApproxEqAbs(usd, 10_000e18, 2e12, "value = USDG + convertToAssets(shares)");
        assertEq(usd, guard.snapshot(address(account)).cashUsd);

        vm.prank(cashKey);
        account.execute("cash", address(cash), _wrap(STEAK_USDG, shares, abi.encode(uint8(1), STEAK_USDG, shares, uint256(1))), _allow(0), 0);
        assertApproxEqAbs(IERC20(USDG).balanceOf(address(account)), 10_000e6, 2);
        assertEq(IERC20(USDG).balanceOf(address(cash)), 0);
    }

    function test_fork_equitySleeveBuysAndSellsAapl() public {
        vm.prank(eqKey);
        bytes memory r = account.execute("equity", address(equity), _wrap(USDG, 1_000e6, abi.encode(uint8(0), AAPL, uint256(1_000e6), uint16(200))), _allow(2), 0);
        uint256 raw = abi.decode(r, (uint256));
        assertEq(IERC20(AAPL).balanceOf(address(account)), raw);
        (uint256 eqUsd, bool hold) = equity.valueOf(address(account));
        assertApproxEqRel(eqUsd, 1_000e18, 0.02e18, "within 2% of what was paid (fee + pool vs oracle)");
        assertEq(eqUsd, guard.snapshot(address(account)).equityUsd);
        hold; // weekends: feed may be held; value still computed

        vm.prank(eqKey);
        account.execute("equity", address(equity), _wrap(AAPL, raw, abi.encode(uint8(1), AAPL, raw, uint16(200))), _allow(0), 0);
        assertEq(IERC20(AAPL).balanceOf(address(account)), 0);
        assertEq(IERC20(AAPL).balanceOf(address(equity)), 0);
    }
}
