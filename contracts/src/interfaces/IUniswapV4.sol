// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal, ABI-compatible subset of the Uniswap v4 PoolManager that StockRouter needs.
/// Written by hand (not vendored). Selectors and struct layouts match the PoolManager deployed on
/// Robinhood Chain at 0x8366a39cc670b4001a1121b8f6a443a643e40951; the mainnet fork test proves it.
///
/// Currency is a plain address here (v4 wraps it in a user-defined value type with the same ABI).
/// BalanceDelta is an int256: amount0 in the upper 128 bits, amount1 in the lower 128, both signed,
/// from the caller's point of view (negative = caller owes the pool, positive = pool owes the caller).

interface IHooks {}

struct PoolKey {
    address currency0; // the lower address
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    IHooks hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    /// Raw storage read (selector 0x1e2eaeaf). Pool state lives at keccak256(abi.encode(poolId, POOLS_SLOT));
    /// its low 160 bits are sqrtPriceX96 (verified on 4663 against StateView.getSlot0, 2026-10-04).
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

library V4Constants {
    /// Storage slot of PoolManager's `_pools` mapping (v4-core StateLibrary.POOLS_SLOT).
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    // TickMath.MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1: "no price limit" for each direction.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    function amount0(int256 delta) internal pure returns (int128) {
        return int128(delta >> 128);
    }

    function amount1(int256 delta) internal pure returns (int128) {
        return int128(delta);
    }
}
