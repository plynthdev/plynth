// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {PerpFixture} from "./PerpFixture.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";

contract PerpPoolTest is PerpFixture {
    function test_pool_isErc4626OverUsdg() public view {
        assertEq(pool.asset(), address(usdg));
        assertEq(pool.totalAssets(), LP_SEED);
        assertEq(pool.convertToAssets(pool.balanceOf(lp)), LP_SEED);
    }

    function test_pool_redeemCooldown24h() public {
        uint256 shares = pool.balanceOf(lp);
        assertEq(pool.maxRedeem(lp), 0);
        vm.prank(lp);
        vm.expectRevert();
        pool.redeem(shares, lp, lp);

        skip(24 hours - 1);
        assertEq(pool.maxWithdraw(lp), 0);
        skip(1);
        vm.prank(lp);
        pool.redeem(shares, lp, lp);
        assertEq(usdg.balanceOf(lp), LP_SEED);
    }

    function test_pool_depositOnlyForSelf() public {
        _fund(alice, 10e6);
        vm.startPrank(alice);
        usdg.approve(address(pool), 10e6);
        vm.expectRevert(PerpPool.ReceiverNotSender.selector);
        pool.deposit(10e6, lp);
        vm.expectRevert(PerpPool.ReceiverNotSender.selector);
        pool.mint(1e6, lp);
        vm.stopPrank();
    }

    function test_pool_shareTransferCarriesCooldown() public {
        skip(2 days); // lp's own cooldown is over
        _fund(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(pool), 100e6);
        uint256 shares = pool.deposit(100e6, alice);
        pool.transfer(bob, shares / 2);
        pool.transfer(lp, shares / 2);
        vm.stopPrank();
        assertEq(pool.maxRedeem(bob), 0);
        assertEq(pool.maxRedeem(lp), 0, "receiving fresh shares restarts the receiver's cooldown");
        skip(24 hours);
        assertGt(pool.maxRedeem(bob), 0);
    }

    function test_pool_withdrawCappedByReserve() public {
        _open(alice, true, 200_000e6, 10_000e6);
        _open(bob, false, 200_000e6, 10_000e6);
        assertEq(pool.totalReserved(), 400_000e6);
        skip(1 days);
        _refresh();
        assertEq(pool.maxWithdraw(lp), 600_000e6);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 600_000e6 + 1, 600_000e6));
        pool.withdraw(600_000e6 + 1, lp, lp);
        vm.prank(lp);
        pool.withdraw(600_000e6, lp, lp);
        assertGe(pool.liquidAssets(), pool.totalReserved());
    }

    function test_pool_openRefusedWhenReserveExceedsCash() public {
        // Two more markets would let OI exceed the pool; the global reserve check refuses the excess.
        _params(0, 0, 50, 0, 0, 10_000, 100_000, 5e6); // 10x profit cap, 100% OI cap
        _fund(alice, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.PoolCapacity.selector, LP_SEED, 1_000_010e6));
        market.open(true, 100_001e6, 10_000e6, 10_000);
        _open(alice, true, 100_000e6, 10_000e6);
    }

    function test_pool_totalAssetsNetsTraderPnl() public {
        _open(alice, true, 100_000e6, 10_000e6);
        _setPrice(110e8);
        assertEq(pool.totalAssets(), LP_SEED - 10_000e6);
        _setPrice(50e8); // trader down 50k but has 10k collateral: LPs count only 10k
        assertEq(pool.totalAssets(), LP_SEED + 10_000e6);
    }

    function test_pool_onlyMarketHooks() public {
        vm.startPrank(alice);
        vm.expectRevert(PerpPool.NotMarket.selector);
        pool.lockCollateral(lp, 1, 1);
        vm.expectRevert(PerpPool.NotMarket.selector);
        pool.settle(alice, 1, 0);
        vm.expectRevert(PerpPool.NotMarket.selector);
        pool.setReserve(0);
        vm.expectRevert();
        pool.addMarket(alice);
        vm.stopPrank();
    }

    function test_pool_supportsInterfaceShape() public view {
        IERC4626 v = IERC4626(address(pool));
        assertEq(v.decimals(), 12); // 6 + 6 virtual-share offset (inflation-attack guard)
    }
}
