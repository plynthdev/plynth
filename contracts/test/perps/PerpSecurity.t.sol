// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "./PerpFixture.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";

/// Exploits from the 2026-10-06 security review, written as tests (each failed before its fix).
contract PerpSecurityTest is PerpFixture {
    address attacker = makeAddr("attacker");

    // ------------------------------------------------------------ S1: cooldown re-dating

    /// A stranger refreshes their own cooldown and pushes it onto an LP with a 0-value transfer.
    function test_S1_zeroValueTransferCannotFreezeAnLp() public {
        skip(2 days);
        _refresh();
        uint256 shares = pool.balanceOf(lp);
        assertGt(pool.maxRedeem(lp), 0);

        _fund(attacker, 1);
        vm.startPrank(attacker);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(1, attacker); // fresh cooldown on the attacker
        vm.expectRevert(); // shares in cooldown cannot leave the account
        pool.transfer(lp, 0);
        vm.stopPrank();

        assertGt(pool.maxRedeem(lp), 0, "lp still free to leave");
        vm.prank(lp);
        pool.redeem(shares, lp, lp);
    }

    /// Past its own cooldown, a transfer does not re-date the receiver either.
    function test_S1_transferNeverRedatesTheReceiver() public {
        skip(1 hours);
        _refresh();
        _fund(attacker, 10e6);
        vm.startPrank(attacker);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(10e6, attacker);
        vm.stopPrank();
        skip(2 days);
        _refresh();
        uint256 lpReadyAt = pool.lastDepositAt(lp);
        vm.prank(attacker);
        pool.transfer(lp, 1);
        assertEq(pool.lastDepositAt(lp), lpReadyAt);
        assertGt(pool.maxRedeem(lp), 0);
    }

    function test_S1_zeroDepositAndMintRefused() public {
        vm.startPrank(attacker);
        vm.expectRevert(PerpPool.ZeroAmount.selector);
        pool.deposit(0, attacker);
        vm.expectRevert(PerpPool.ZeroAmount.selector);
        pool.mint(0, attacker);
        vm.stopPrank();
        assertEq(pool.lastDepositAt(attacker), 0);
    }
}
