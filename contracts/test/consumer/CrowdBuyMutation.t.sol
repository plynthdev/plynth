// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon, IShieldedDeposit} from "../../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../../src/consumer/StealthClaims.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Tests that close gaps found by mutation testing (contracts/mutation/REPORT.md). Reverts from `new` are
/// checked with try/catch, not vm.expectRevert: with dynamic test linking a `vm.expectRevert(); new X()` ends
/// the test at that revert.
contract CrowdBuyMutationTest is CrowdBuyBase {
    bytes32 constant SECRET = keccak256("m");

    function _deployReason(SavingsVault v, StockRouter r, IExecuteBeacon b, uint16 slip, uint64 window)
        internal
        returns (bytes4 reason)
    {
        try new CrowdBuy(v, r, b, 3, slip, GENESIS, owner, keeper, window) returns (CrowdBuy) {
            return bytes4(0);
        } catch (bytes memory err) {
            return bytes4(err);
        }
    }

    // ---------------------------------------------------------------- constructor

    function test_constructorRejectsEachZeroAddress() public {
        IExecuteBeacon b = IExecuteBeacon(address(beacon));
        bytes4 zero = CrowdBuy.ZeroAddress.selector;
        assertEq(_deployReason(SavingsVault(address(0)), router, b, SLIP, 1 days), zero);
        assertEq(_deployReason(vault, StockRouter(address(0)), b, SLIP, 1 days), zero);
        assertEq(_deployReason(vault, router, IExecuteBeacon(address(0)), SLIP, 1 days), zero);
    }

    function test_constructorRejectsRouterWithAnotherUsdg() public {
        MockUSDG other = new MockUSDG();
        SavingsVault v2 = new SavingsVault(
            IERC20(address(other)), makeAddr("permit2"), ICanonicalRegistry(address(registry)), owner, keeper
        );
        assertEq(_deployReason(v2, router, IExecuteBeacon(address(beacon)), SLIP, 1 days), CrowdBuy.BadParam.selector);
    }

    function test_constructorSlippageCapIsInclusive() public {
        IExecuteBeacon b = IExecuteBeacon(address(beacon));
        assertEq(_deployReason(vault, router, b, 301, 1 days), CrowdBuy.BadParam.selector);
        assertEq(_deployReason(vault, router, b, 300, 1 days), bytes4(0));
    }

    /// A window between MIN_WINDOW and the beacon's GRACE is refused (not only one equal to GRACE).
    function test_constructorRejectsWindowShorterThanGrace() public {
        JitterBeacon longGrace = new JitterBeacon(keeper, owner, 3 hours);
        IExecuteBeacon b = IExecuteBeacon(address(longGrace));
        assertEq(_deployReason(vault, router, b, SLIP, 2 hours), CrowdBuy.BadWindow.selector);
        assertEq(_deployReason(vault, router, b, SLIP, 3 hours), CrowdBuy.BadWindow.selector);
        assertEq(_deployReason(vault, router, b, SLIP, 3 hours + 1), bytes4(0));
    }

    // ---------------------------------------------------------------- one-time wiring

    function test_setStealthClaimsAndShieldedPoolRejectZero() public {
        vm.startPrank(owner);
        vm.expectRevert(CrowdBuy.ZeroAddress.selector);
        crowd.setStealthClaims(StealthClaims(address(0)));
        vm.expectRevert(CrowdBuy.ZeroAddress.selector);
        crowd.setShieldedPool(IShieldedDeposit(address(0)));
        vm.stopPrank();
    }

    function test_deliverStealthNeedsStealthClaims() public {
        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.QuietNotConfigured.selector);
        crowd.deliverStealth(address(tokA), makeAddr("stealth"), 1, new bytes(33), 0x00);
    }

    // ---------------------------------------------------------------- orders and settlement

    function test_allocationIsZeroBeforeExecution() public {
        address u = _user(0);
        _joinA(u, 10 * U);
        assertEq(crowd.allocationOf(address(tokA), 0, u), 0);
    }

    /// A mix entry whose floor share is zero places no order and does not count as an account.
    function test_joinSkipsZeroPartsAndCountsNoAccount() public {
        address u = _user(0);
        address[] memory a = new address[](2);
        uint16[] memory w = new uint16[](2);
        (a[0], a[1]) = (address(tokA), address(tokB));
        (w[0], w[1]) = (1, 9_999);
        _prepare(u, a, w, 5); // 5 raw USDG units: 5 * 1 / 10_000 floors to 0 for token A
        vm.prank(u); // only the saver or the keeper may join (L-3)
        crowd.join(u);
        (, CrowdBuy.Book memory bA) = crowd.openBook(address(tokA));
        (, CrowdBuy.Book memory bB) = crowd.openBook(address(tokB));
        assertEq(bA.accounts, 0, "no phantom account");
        assertEq(bA.usdgTotal, 0);
        assertEq(crowd.orderOf(address(tokA), 0, u), 0);
        assertEq(bB.accounts, 1);
        assertEq(bB.usdgTotal, 5);
    }

    /// The permissionless fallback stays open for the rest of the window, not only at windowEnd - GRACE.
    function test_permissionlessFallbackWorksAfterTheFallbackMoment() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS + 1 days - 1 hours + 20 minutes);
        _freshFeeds();
        vm.prank(makeAddr("stranger"));
        crowd.execute(address(tokA));
        assertTrue(crowd.book(address(tokA), 0).executed);
    }
}
