// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {IHooks, IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";

/// StockRouter against the real Uniswap v4 PoolManager and the default hookless USDG/AAPL pool on a
/// Robinhood Chain mainnet fork. Skips when RHC_MAINNET_RPC_URL is unset. Nothing is broadcast.
contract StockRouterForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    bytes32 constant AAPL_POOL_ID = 0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb; // not-a-key

    StockRouter router;
    StockTokenRegistry reg;
    PoolKey key;
    address board = makeAddr("board");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        reg = new StockTokenRegistry(board);
        // Equity feeds do not update off-hours (weekends); allow a week so the test runs any day.
        Valuer valuer = new Valuer(reg, 7 days);
        vm.prank(board);
        reg.list(AAPL, AAPL_FEED, true);
        router = new StockRouter(IPoolManager(POOL_MANAGER), reg, valuer, IERC20Metadata(USDG), board);
        key = PoolKey(USDG, AAPL, 3000, 60, IHooks(address(0)));
        vm.prank(board);
        router.setPool(AAPL, key);
    }

    function _fund(address to, uint256 amount) internal {
        // USDG is a proxy; take from the PoolManager's balance (it holds every pool's USDG) on the fork.
        vm.prank(POOL_MANAGER);
        IERC20(USDG).transfer(to, amount);
    }

    function test_fork_poolKeyMatchesVerifiedPoolId() public view {
        assertEq(keccak256(abi.encode(key)), AAPL_POOL_ID);
        assertEq(router.usdgDecimals(), 6);
    }

    function test_fork_buyAndSellAaplWithUsdg() public {
        _fund(alice, 100e6);
        (uint256 minOut,) = router.quoteMinOut(AAPL, 100e6, true, 200);
        assertGt(minOut, 0);

        vm.startPrank(alice);
        IERC20(USDG).approve(address(router), 100e6);
        uint256 out = router.buy(AAPL, 100e6, 200, bob);
        vm.stopPrank();

        assertGe(out, minOut);
        assertEq(IERC20(AAPL).balanceOf(bob), out);
        assertEq(IERC20(USDG).balanceOf(alice), 0);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
        assertEq(IERC20(AAPL).balanceOf(address(router)), 0);

        vm.startPrank(bob);
        IERC20(AAPL).approve(address(router), out);
        uint256 back = router.sell(AAPL, out, 200, alice);
        vm.stopPrank();

        assertGt(back, 98e6); // two 0.3% fees plus spread
        assertEq(IERC20(USDG).balanceOf(alice), back);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
        assertEq(IERC20(AAPL).balanceOf(address(router)), 0);
    }

    function test_fork_tightSlippageReverts() public {
        _fund(alice, 100e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(router), 100e6);
        vm.expectPartialRevert(StockRouter.Slippage.selector);
        router.buy(AAPL, 100e6, 0, alice); // pool fee alone puts output below a 0-bps oracle minimum
        vm.stopPrank();
    }
}
