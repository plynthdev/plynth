// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestnetPoolMath} from "../../src/testnet/TestnetPoolMath.sol";

contract PoolMathHarness {
    function sqrtP(uint256 p, uint8 ud, uint8 td, bool u0) external pure returns (uint160) {
        return TestnetPoolMath.sqrtPriceX96For(p, ud, td, u0);
    }

    function fullRange(int24 s) external pure returns (int24, int24) {
        return TestnetPoolMath.fullRange(s);
    }
}

contract TestnetPoolMathTest is Test {
    PoolMathHarness h = new PoolMathHarness();

    /// Known value: USDG(6dp) currency1, token(18dp) at $250 -> price = 250e6/1e18 = 2.5e-10,
    /// sqrt = 1.5811388e-5, x 2^96 = 1.2526e24.
    function test_sqrtPriceKnownValue() public pure {
        uint160 s = TestnetPoolMath.sqrtPriceX96For(250e18, 6, 18, false);
        assertApproxEqRel(uint256(s), 1252707241875239655932069, 1e12);
    }

    function test_fullRangeForSpacing60() public pure {
        (int24 lo, int24 hi) = TestnetPoolMath.fullRange(60);
        assertEq(lo, -887220);
        assertEq(hi, 887220);
    }

    function test_badTickSpacingReverts() public {
        vm.expectRevert(TestnetPoolMath.BadTickSpacing.selector);
        h.fullRange(0);
    }

    function test_zeroPriceReverts() public {
        vm.expectRevert(TestnetPoolMath.PriceOutOfRange.selector);
        h.sqrtP(0, 6, 18, true);
    }

    /// Round trip: the pool price implied by sqrtPriceX96For equals the oracle price to within 1e-9.
    function testFuzz_sqrtPriceRoundTrip(uint256 p, bool usdgIs0) public pure {
        p = bound(p, 1e16, 1e24); // $0.01 .. $1,000,000 per token
        uint160 s = TestnetPoolMath.sqrtPriceX96For(p, 6, 18, usdgIs0);
        uint256 back = TestnetPoolMath.priceUsdPerTokenAt(s, 6, 18, usdgIs0);
        assertApproxEqRel(back, p, 1e9);
    }

    /// Liquidity sized from the USDG side needs equal USD value of the token side at the pool price.
    function testFuzz_liquidityIsBalancedInValue(uint256 p, uint256 usdgAmount, bool usdgIs0) public pure {
        p = bound(p, 1e17, 1e22); // $0.1 .. $10,000
        usdgAmount = bound(usdgAmount, 1_000e6, 10_000_000e6);
        uint160 s = TestnetPoolMath.sqrtPriceX96For(p, 6, 18, usdgIs0);
        uint128 l = TestnetPoolMath.liquidityForUsdg(s, usdgAmount, usdgIs0);
        uint256 tokenRaw = TestnetPoolMath.tokenAmountFor(s, l, usdgIs0);
        uint256 tokenUsd6 = tokenRaw * p / 1e18 / 1e12; // USD value in 6dp
        assertApproxEqRel(tokenUsd6, usdgAmount, 1e12); // 1e-6 relative
    }
}
