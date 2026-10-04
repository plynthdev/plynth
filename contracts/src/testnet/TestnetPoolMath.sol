// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice TESTNET ONLY. Price and liquidity arithmetic for seeding full-range USDG/Stock Token v4 pools.
///
/// v4 price = currency1 base units per currency0 base unit; sqrtPriceX96 = sqrt(price) * 2^96.
/// p = USD per one whole Stock Token, 1e18-scaled (from Valuer, multiplier already applied); USDG = 1 USD.
///   USDG is currency0: price = 10^td * 1e18 / (p * 10^ud)      (token units per USDG unit)
///   USDG is currency1: price = p * 10^ud / (10^td * 1e18)      (USDG units per token unit)
/// Full-range liquidity is sized from the USDG side, treating the range as (0, inf):
///   USDG is currency0: amount0 = L * 2^96 / sqrtP  ->  L = amount0 * sqrtP / 2^96
///   USDG is currency1: amount1 = L * sqrtP / 2^96  ->  L = amount1 * 2^96 / sqrtP
/// The true full-range amounts are slightly smaller, so these estimates are upper bounds (fund with them).
library TestnetPoolMath {
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant Q192 = 2 ** 192;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    int24 internal constant MAX_TICK = 887272;

    error PriceOutOfRange();
    error LiquidityOverflow();
    error BadTickSpacing();

    function sqrtPriceX96For(uint256 priceUsdPerToken, uint8 usdgDecimals, uint8 tokenDecimals, bool usdgIsCurrency0)
        internal
        pure
        returns (uint160)
    {
        uint256 tokenScale = 10 ** tokenDecimals * 1e18;
        uint256 usdScale = priceUsdPerToken * 10 ** usdgDecimals;
        if (usdScale == 0) revert PriceOutOfRange();
        uint256 priceX192 =
            usdgIsCurrency0 ? Math.mulDiv(tokenScale, Q192, usdScale) : Math.mulDiv(usdScale, Q192, tokenScale);
        uint256 s = Math.sqrt(priceX192);
        if (s < MIN_SQRT_PRICE || s >= MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(s);
    }

    /// Inverse of sqrtPriceX96For: USD per whole token (1e18), rounded down.
    function priceUsdPerTokenAt(uint160 sqrtPriceX96, uint8 usdgDecimals, uint8 tokenDecimals, bool usdgIsCurrency0)
        internal
        pure
        returns (uint256)
    {
        uint256 priceX96 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96); // price * 2^96
        uint256 tokenScale = 10 ** tokenDecimals * 1e18;
        uint256 usdgUnit = 10 ** usdgDecimals;
        if (usdgIsCurrency0) {
            // p = tokenScale / (price * 10^ud)
            return Math.mulDiv(tokenScale, Q96, priceX96 * usdgUnit);
        }
        // p = price * tokenScale / 10^ud
        return Math.mulDiv(priceX96, tokenScale, Q96 * usdgUnit);
    }

    function liquidityForUsdg(uint160 sqrtPriceX96, uint256 usdgAmount, bool usdgIsCurrency0)
        internal
        pure
        returns (uint128)
    {
        uint256 l = usdgIsCurrency0
            ? Math.mulDiv(usdgAmount, sqrtPriceX96, Q96)
            : Math.mulDiv(usdgAmount, Q96, sqrtPriceX96);
        if (l > type(uint128).max) revert LiquidityOverflow();
        return uint128(l);
    }

    /// Upper bound of Stock Token base units a full-range position of `liquidity` needs at this price.
    function tokenAmountFor(uint160 sqrtPriceX96, uint128 liquidity, bool usdgIsCurrency0)
        internal
        pure
        returns (uint256)
    {
        return usdgIsCurrency0
            ? Math.mulDiv(liquidity, sqrtPriceX96, Q96, Math.Rounding.Ceil)
            : Math.mulDiv(liquidity, Q96, sqrtPriceX96, Math.Rounding.Ceil);
    }

    /// Widest usable tick range for a tick spacing (both ends multiples of the spacing).
    function fullRange(int24 tickSpacing) internal pure returns (int24 lower, int24 upper) {
        if (tickSpacing <= 0) revert BadTickSpacing();
        upper = (MAX_TICK / tickSpacing) * tickSpacing;
        lower = -upper;
    }
}
