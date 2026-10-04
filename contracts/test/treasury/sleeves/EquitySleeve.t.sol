// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StockRouter} from "../../../src/core/StockRouter.sol";
import {EquitySleeve} from "../../../src/treasury/sleeves/EquitySleeve.sol";
import {MockStockERC20} from "../../mocks/MockV4.sol";
import {SleeveFixture} from "./SleeveFixture.sol";

contract EquitySleeveTest is SleeveFixture {
    // ---------------------------------------------------------------- declaration

    function test_assetsAreStockTokensInEquityBand() public view {
        (address[] memory a, uint8[] memory k) = equity.assets();
        assertEq(a.length, 3);
        assertEq(a[0], address(aapl));
        assertEq(a[2], address(thin));
        assertEq(a[1], address(nvda));
        assertEq(k[0], 2);
        assertEq(k[1], 2);
        assertEq(equity.band(), 1);
        assertEq(address(equity.valuer()), address(valuer));
        assertEq(address(equity.usdg()), address(usdg));
    }

    function test_constructorRejectsDuplicatesUsdgAndTooMany() public {
        address[] memory t = new address[](2);
        t[0] = address(aapl);
        t[1] = address(aapl);
        vm.expectRevert(abi.encodeWithSelector(EquitySleeve.DuplicateToken.selector, address(aapl)));
        new EquitySleeve(router, t);
        t[1] = address(usdg);
        vm.expectRevert(EquitySleeve.ZeroAddress.selector);
        new EquitySleeve(router, t);
        vm.expectRevert(EquitySleeve.TooManyTokens.selector);
        new EquitySleeve(router, new address[](17));
    }

    // ---------------------------------------------------------------- buy / sell

    function test_buyThroughRouterSendsTokensToAccount() public {
        uint256 out = _buy(address(aapl), 50_000e6);
        assertEq(aapl.balanceOf(address(account)), out);
        // 50,000 / 200.34 per token, minus the 0.05% pool fee.
        assertApproxEqRel(out, uint256(50_000e18) * 1e18 / 200.34e18 * 9995 / 10_000, 1e12);
        assertEq(usdg.balanceOf(address(account)), FUNDING - 50_000e6);
        _assertSleevesEmpty();
    }

    function test_sellThroughRouterReturnsUsdg() public {
        uint256 raw = _buy(address(nvda), 20_000e6);
        uint256 got = _sell(address(nvda), raw);
        assertEq(nvda.balanceOf(address(account)), 0);
        assertApproxEqRel(got, 20_000e6 * 9990 / 10_000, 1e14);
        _assertSleevesEmpty();
    }

    function test_holdingsAreRawUnits() public {
        uint256 a = _buy(address(aapl), 10_000e6);
        uint256 n = _buy(address(nvda), 5_000e6);
        (address[] memory t, uint256[] memory raw) = equity.holdings(address(account));
        assertEq(t[0], address(aapl));
        assertEq(raw[0], a);
        assertEq(raw[1], n);
    }

    // ---------------------------------------------------------------- valueOf

    /// Feed is per share ($200), multiplier 1.0017: value = raw x 200 x 1.0017 exactly once.
    function test_valueOfAppliesMultiplierOnce() public {
        aapl.mint(address(account), 100e18);
        (uint256 usd, bool hold) = equity.valueOf(address(account));
        assertEq(usd, 100e18 * 200.34e18 / 1e18);
        assertFalse(hold);
        assertEq(usd, guard.snapshot(address(account)).equityUsd, "sleeve value == guard equity band");
    }

    function test_valueOfFlagsHoldOnStaleFeed() public {
        aapl.mint(address(account), 1e18);
        vm.warp(T0 + 2 hours);
        nvdaFeed.setUpdatedAt(block.timestamp);
        (, bool hold) = equity.valueOf(address(account));
        assertTrue(hold);
    }

    // ---------------------------------------------------------------- policy-bounded slippage

    function test_slippageAboveGuardLossBoundReverts() public {
        vm.prank(eqKey);
        vm.expectRevert(abi.encodeWithSelector(EquitySleeve.SlippageAbovePolicy.selector, uint16(201), MAX_LOSS_BPS));
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 1_000e6, 201), _allow(address(aapl)), 0);
    }

    function test_slippageAtBoundAccepted() public {
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 1_000e6, MAX_LOSS_BPS), _allow(address(aapl)), 0);
    }

    function test_poolFarFromOracleRevertsInRouter() public {
        _setPoolPrice(address(aapl), 210e18); // pool 5% worse than the oracle
        vm.prank(eqKey);
        vm.expectRevert(); // StockRouter.Slippage
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 1_000e6, SLIP), _allow(address(aapl)), 0);
    }

    // ---------------------------------------------------------------- per-name float cap

    function test_floatCapBlocksBuyOverCap() public {
        // A thin token: supply 500 NVDB, 1% = 5 tokens = $500. Buying $600 would exceed it.
        vm.prank(eqKey);
        vm.expectPartialRevert(EquitySleeve.FloatCapExceeded.selector);
        account.execute(EQUITY_DESK, address(equity), _buyData(address(thin), 600e6, SLIP), _allow(address(thin)), 0);
    }

    function test_floatCapAllowsBuyUpToCap() public {
        _buy(address(thin), 499e6);
        assertLe(thin.balanceOf(address(account)), equity.floatCapRaw(address(thin), 100));
        assertGt(thin.balanceOf(address(account)), 4.9e18);
    }

    function test_floatCapNeverBlocksSells() public {
        thin.mint(address(account), 20e18); // airdropped over the cap (supply now 520, cap 5.2)
        _sell(address(thin), 10e18);
        assertEq(thin.balanceOf(address(account)), 10e18);
    }

    function testFuzz_floatCapBoundary(uint256 supply, uint16 capBps) public {
        supply = bound(supply, 1, 1e30);
        capBps = uint16(bound(capBps, 0, 200));
        MockStockERC20 t = new MockStockERC20("F", 18);
        t.mint(address(1), supply);
        address[] memory toks = new address[](1);
        toks[0] = address(t);
        EquitySleeve s = new EquitySleeve(router, toks);
        uint256 cap = s.floatCapRaw(address(t), capBps);
        assertEq(cap, supply * capBps / 10_000);
        // Never more than the exact fraction, and within one raw unit of it.
        assertLe(cap * 10_000, supply * capBps);
        assertGt((cap + 1) * 10_000, supply * capBps);
    }

    // ---------------------------------------------------------------- caller / guard

    function test_unknownTokenAndOpRevert() public {
        bytes memory d = _wrap(address(usdg), 1e6, abi.encode(uint8(0), address(usdg), uint256(1e6), SLIP));
        vm.prank(eqKey);
        vm.expectRevert(abi.encodeWithSelector(EquitySleeve.UnknownToken.selector, address(usdg)));
        account.execute(EQUITY_DESK, address(equity), d, _allow(address(aapl)), 0);

        d = _wrap(address(usdg), 1e6, abi.encode(uint8(9), address(aapl), uint256(1e6), SLIP));
        vm.prank(eqKey);
        vm.expectRevert(abi.encodeWithSelector(EquitySleeve.UnknownOp.selector, uint8(9)));
        account.execute(EQUITY_DESK, address(equity), d, _allow(address(aapl)), 0);
    }

    function test_nonAccountCallerReverts() public {
        vm.expectRevert();
        equity.run(abi.encode(uint8(0), address(aapl), uint256(1e6), uint16(0)));
    }

    function test_buyOverOrderCapRejectedByGuard() public {
        _expectCode(4); // R3_ORDER_CAP: $210k > $200k
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 210_000e6, SLIP), _allow(address(aapl)), 0);
    }

    function test_buyAboveApprovalNeedsTicket() public {
        _expectCode(11); // R9_APPROVAL: $160k > $150k without a board ticket
        vm.prank(eqKey);
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 160_000e6, SLIP), _allow(address(aapl)), 0);
    }

    function test_buyOnStaleFeedRevertsInRouter() public {
        vm.warp(T0 + 2 hours);
        vm.prank(eqKey);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.MarketOnHold.selector, address(aapl)));
        account.execute(EQUITY_DESK, address(equity), _buyData(address(aapl), 1_000e6, SLIP), _allow(address(aapl)), 0);
    }

    function test_donationDoesNotBlockSleeve() public {
        usdg.mint(address(equity), 1e6);
        aapl.mint(address(equity), 1e18);
        _buy(address(aapl), 1_000e6);
        assertEq(usdg.balanceOf(address(equity)), 1e6);
    }

    function testFuzz_buySellRoundTripLosesAtMostFees(uint256 usdgIn, bool useNvda) public {
        usdgIn = bound(usdgIn, 1e6, 140_000e6);
        address t = useNvda ? address(nvda) : address(aapl);
        uint256 navBefore = guard.snapshot(address(account)).nav;
        uint256 raw = _buy(t, usdgIn);
        (uint256 eqUsd,) = equity.valueOf(address(account));
        assertEq(eqUsd, guard.snapshot(address(account)).equityUsd);
        _sell(t, raw);
        uint256 navAfter = guard.snapshot(address(account)).nav;
        assertLe(navAfter, navBefore);
        // Two 0.05% pool fees plus rounding.
        assertGe(navAfter, navBefore - usdgIn * 1e12 * 11 / 10_000 - 2e12);
        _assertSleevesEmpty();
    }
}
