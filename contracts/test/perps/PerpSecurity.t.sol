// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "./PerpFixture.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";

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

    // ------------------------------------------------------------ S4: funding over an idle interval

    function _skewedBookIdle() internal {
        _params(0, 0, 1000, 0, 1e12, 5_000, 10_000, 5e6);
        _open(alice, true, 200_000e6, 20_000e6);
        _open(bob, false, 50_000e6, 5_000e6);
        skip(64 hours); // e.g. a weekend nobody touches the market
        _refresh();
    }

    /// An LP past cooldown shrinks the pool just before the first accrual: the whole 64h must still be
    /// charged at the liquidity that was really there.
    function test_S4_withdrawBeforeAccrualCannotRepriceThePast() public {
        _skewedBookIdle();
        uint256 snap = vm.snapshotState();
        market.funding();
        int256 honest = market.longFundingIndex();
        assertGt(honest, 0);
        vm.revertToState(snap);

        vm.startPrank(lp);
        pool.withdraw(pool.maxWithdraw(lp), lp, lp);
        vm.stopPrank();
        market.funding();
        assertEq(market.longFundingIndex(), honest, "funding for the idle window follows the old liquidity");
    }

    /// Mirror: a heavy-side whale deposits a lot just before accrual to erase the funding it owes.
    function test_S4_depositBeforeAccrualCannotErasePastFunding() public {
        _skewedBookIdle();
        uint256 snap = vm.snapshotState();
        market.funding();
        int256 honest = market.longFundingIndex();
        vm.revertToState(snap);

        _fund(alice, 10_000_000e6);
        vm.prank(alice);
        pool.deposit(10_000_000e6, alice);
        market.funding();
        assertEq(market.longFundingIndex(), honest);
    }

    // ------------------------------------------------------------ S11: LP entry/exit at a stale share price

    /// Traders are long, the feed is on hold and the real price has moved up off-chain: an LP past cooldown
    /// must not redeem at the stale (overstated) share price and leave the reprice to the others.
    function test_S11_noRedeemAtStaleSharePrice() public {
        _open(alice, true, 200_000e6, 20_000e6);
        skip(2 days);
        _hold();
        uint256 shares = pool.balanceOf(lp);
        assertEq(pool.maxRedeem(lp), 0, "exits wait for a fresh price");
        assertEq(pool.maxWithdraw(lp), 0);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.MarketOnHold.selector, address(market)));
        pool.redeem(shares / 10, lp, lp);

        _refresh();
        vm.prank(lp);
        pool.redeem(shares / 10, lp, lp);
    }

    /// Mirror: nobody buys shares at a stale (understated) price ahead of a known favourable reprice.
    function test_S11_noDepositAtStaleSharePrice() public {
        _open(alice, true, 200_000e6, 20_000e6);
        _hold();
        _fund(attacker, 100_000e6);
        vm.startPrank(attacker);
        usdg.approve(address(pool), type(uint256).max);
        assertEq(pool.maxDeposit(attacker), 0);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.MarketOnHold.selector, address(market)));
        pool.deposit(100_000e6, attacker);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.MarketOnHold.selector, address(market)));
        pool.mint(1e12, attacker);
        vm.stopPrank();
    }

    /// A market on hold with no open interest (e.g. a delisted token) does not block the pool.
    function test_S11_heldMarketWithoutOpenInterestDoesNotBlock() public {
        skip(2 days);
        _hold();
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.redeem(shares / 10, lp, lp);
    }

    // ------------------------------------------------------------ S10: hold exits as a free option

    /// Earnings gap after the close: the stock trades 8% lower off-chain while the feed is stale. The trader
    /// runs a long and a short, closes the losing long at the stale price and keeps the winning short until
    /// the feed updates. With the deployed hold spread this must not be profitable against the LPs.
    function test_S10_pairTradeAcrossAHoldGapDoesNotDrainLps() public {
        uint256 spread = new PerpMarket(pool, valuer, address(token), owner).offHoursSpreadBps();
        _params(10, 2, spread, 1, 0, 2_000, 10_000, 5e6);
        uint256 lpBefore = pool.totalAssets();

        _open(alice, true, 100_000e6, 10_000e6); // A
        _open(bob, false, 100_000e6, 10_000e6); // B, same owner
        _hold();
        skip(2 hours);
        uint256 got = _close(alice); // the losing leg exits at the stale price
        _setPrice(92e8); // feed reopens at the real price
        got += _close(bob);

        assertLe(got, 20_000e6, "the pair trade must not profit from the stale exit");
        assertGe(pool.totalAssets(), lpBefore, "LPs do not pay for the off-hours gap");
    }

    function test_S10_holdSpreadHasAFloor() public {
        vm.prank(owner);
        vm.expectRevert(PerpMarket.BadParams.selector);
        market.setParams(10, 2, 50, 1, 0, 2_000, 10_000, 5e6);
    }
}
