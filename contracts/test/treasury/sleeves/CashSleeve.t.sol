// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {CashSleeve} from "../../../src/treasury/sleeves/CashSleeve.sol";
import {PolicyGuard} from "../../../src/treasury/PolicyGuard.sol";
import {MockERC20} from "../../mocks/MockV4.sol";
import {MockCashVault} from "../mocks/TreasuryMocks.sol";
import {SleeveFixture} from "./SleeveFixture.sol";

/// Pulls only part of what it is asked to deposit (a broken or hostile vault).
contract ShortPullVault is MockCashVault {
    constructor(IERC20 u) MockCashVault(u) {}

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        return super.deposit(assets / 2, receiver);
    }
}

contract CashSleeveTest is SleeveFixture {
    // ---------------------------------------------------------------- construction / declaration

    function test_assetsAreUsdgThenVaultsWithKinds() public view {
        (address[] memory a, uint8[] memory k) = cash.assets();
        assertEq(a.length, 2);
        assertEq(a[0], address(usdg));
        assertEq(a[1], address(vault));
        assertEq(k[0], 0);
        assertEq(k[1], 1);
        assertEq(cash.band(), 0);
        assertEq(cash.vaults()[0], address(vault));
        assertTrue(cash.isVault(address(vault)));
    }

    function test_constructorRejectsVaultOverAnotherAsset() public {
        MockERC20 other = new MockERC20("DAI", 18);
        IERC4626[] memory vs = new IERC4626[](1);
        vs[0] = IERC4626(address(new MockCashVault(IERC20(address(other)))));
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.WrongUnderlying.selector, address(vs[0])));
        new CashSleeve(valuer, IERC20(address(usdg)), vs);
    }

    function test_constructorRejectsDuplicateVault() public {
        IERC4626[] memory vs = new IERC4626[](2);
        vs[0] = IERC4626(address(vault));
        vs[1] = IERC4626(address(vault));
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.DuplicateVault.selector, address(vault)));
        new CashSleeve(valuer, IERC20(address(usdg)), vs);
    }

    function test_constructorRejectsTooManyVaults() public {
        IERC4626[] memory vs = new IERC4626[](16);
        vm.expectRevert(CashSleeve.TooManyVaults.selector);
        new CashSleeve(valuer, IERC20(address(usdg)), vs);
    }

    function test_worksWithPlainUsdgAndNoVault() public {
        CashSleeve plain = new CashSleeve(valuer, IERC20(address(usdg)), new IERC4626[](0));
        (address[] memory a,) = plain.assets();
        assertEq(a.length, 1);
        (uint256 usd, bool hold) = plain.valueOf(address(account));
        assertEq(usd, 1_000_000e18);
        assertFalse(hold);
    }

    // ---------------------------------------------------------------- valueOf

    function test_valueOfIsUsdgPlusConvertToAssets() public {
        _deposit(140_000e6);
        // Vault earns 10%: 14,000 USDG of yield lands in the vault.
        usdg.mint(address(vault), 14_000e6);
        uint256 shares = vault.balanceOf(address(account));
        uint256 expected = (usdg.balanceOf(address(account)) + vault.convertToAssets(shares)) * 1e12;
        (uint256 usd, bool hold) = cash.valueOf(address(account));
        assertEq(usd, expected);
        assertApproxEqAbs(usd, 1_014_000e18, 1e12);
        assertFalse(hold);
        assertEq(usd, guard.snapshot(address(account)).cashUsd, "sleeve value == guard cash band");
    }

    // ---------------------------------------------------------------- run

    function test_depositSendsSharesToAccountAndLeavesNothing() public {
        uint256 shares = _deposit(150_000e6);
        assertEq(vault.balanceOf(address(account)), shares);
        assertEq(usdg.balanceOf(address(account)), 850_000e6);
        _assertSleevesEmpty();
    }

    function test_redeemReturnsUsdgToAccount() public {
        uint256 shares = _deposit(150_000e6);
        uint256 got = _redeem(shares / 2);
        assertEq(got, 75_000e6);
        assertEq(usdg.balanceOf(address(account)), 925_000e6);
        assertEq(vault.balanceOf(address(account)), shares - shares / 2);
        _assertSleevesEmpty();
    }

    function test_unknownVaultReverts() public {
        MockCashVault other = new MockCashVault(IERC20(address(usdg)));
        bytes memory d = _wrap(address(usdg), 1e6, abi.encode(uint8(0), address(other), uint256(1e6), uint256(0)));
        vm.prank(cashKey);
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.UnknownVault.selector, address(other)));
        account.execute(CASH_DESK, address(cash), d, _allow(address(vault)), 0);
    }

    function test_zeroAmountAndUnknownOpRevert() public {
        bytes memory d = _wrap(address(usdg), 0, abi.encode(uint8(0), address(vault), uint256(0), uint256(0)));
        vm.prank(cashKey);
        vm.expectRevert(CashSleeve.ZeroAmount.selector);
        account.execute(CASH_DESK, address(cash), d, _allow(address(vault)), 0);

        d = _wrap(address(usdg), 1e6, abi.encode(uint8(7), address(vault), uint256(1e6), uint256(0)));
        vm.prank(cashKey);
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.UnknownOp.selector, uint8(7)));
        account.execute(CASH_DESK, address(cash), d, _allow(address(vault)), 0);
    }

    function test_minOutEnforced() public {
        vm.prank(cashKey);
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.MinOut.selector, 100e6 + 1, 100e6));
        account.execute(CASH_DESK, address(cash), _depositData(100e6, 100e6 + 1), _allow(address(vault)), 0);
    }

    function test_shortPullVaultRejectedAsResidual() public {
        ShortPullVault sv = new ShortPullVault(IERC20(address(usdg)));
        IERC4626[] memory vs = new IERC4626[](1);
        vs[0] = IERC4626(address(sv));
        CashSleeve s = new CashSleeve(valuer, IERC20(address(usdg)), vs);
        usdg.mint(address(this), 10e6);
        usdg.approve(address(s), 10e6);
        vm.expectRevert(abi.encodeWithSelector(CashSleeve.Residual.selector, address(usdg)));
        s.run(abi.encode(uint8(0), address(sv), uint256(10e6), uint256(0)));
    }

    function test_donationDoesNotBlockSleeve() public {
        usdg.mint(address(cash), 5e6);
        _deposit(1_000e6);
        assertEq(usdg.balanceOf(address(cash)), 5e6);
    }

    function test_depositOverOrderCapRejectedByGuard() public {
        _expectCode(4); // R3_ORDER_CAP: 250k > 200k
        vm.prank(cashKey);
        account.execute(CASH_DESK, address(cash), _depositData(250_000e6, 0), _allow(address(vault)), 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// Deposit then redeem everything: USDG comes back to within vault rounding; NAV never grows.
    function testFuzz_depositRedeemConservesValue(uint256 amount, uint256 yield_) public {
        amount = bound(amount, 1, 140_000e6);
        yield_ = bound(yield_, 0, 10_000e6);
        uint256 navBefore = guard.snapshot(address(account)).nav;
        uint256 shares = _deposit(amount);
        if (yield_ > 0) usdg.mint(address(vault), yield_);
        (uint256 v,) = cash.valueOf(address(account));
        assertEq(v, guard.snapshot(address(account)).nav, "sleeve == guard");
        if (shares > 0) _redeem(shares);
        uint256 navAfter = guard.snapshot(address(account)).nav;
        assertLe(navAfter, navBefore + yield_ * 1e12, "no value from nowhere");
        assertGe(navAfter + 2e12, navBefore, "loses at most rounding");
        _assertSleevesEmpty();
    }
}
