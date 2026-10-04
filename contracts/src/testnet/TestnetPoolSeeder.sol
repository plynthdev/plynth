// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IPoolManager, IUnlockCallback, ModifyLiquidityParams, PoolKey, V4Constants
} from "../interfaces/IUniswapV4.sol";
import {TestnetPoolMath} from "./TestnetPoolMath.sol";

/// @notice TESTNET ONLY. Creates a v4 pool on the chain's real PoolManager and adds one full-range
/// position owned by this contract. The owner funds it with both tokens first; whatever the pool does
/// not take is sent back to the owner in the same call, so the seeder never keeps a balance.
/// ERC-20 pairs only (no native ETH). The position is not meant to be withdrawn: demo liquidity.
contract TestnetPoolSeeder is Ownable, IUnlockCallback {
    using SafeERC20 for IERC20;
    using V4Constants for int256;

    IPoolManager public immutable poolManager;

    event Seeded(bytes32 indexed poolId, uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint256 paid0, uint256 paid1);

    error NotPoolManager();
    error NativeNotSupported();
    error UnexpectedCredit();

    constructor(IPoolManager pm) Ownable(msg.sender) {
        poolManager = pm;
    }

    function seed(PoolKey calldata key, uint160 sqrtPriceX96, uint128 liquidity)
        external
        onlyOwner
        returns (bytes32 poolId, int24 tick)
    {
        if (key.currency0 == address(0) || key.currency1 == address(0)) revert NativeNotSupported();
        tick = poolManager.initialize(key, sqrtPriceX96);
        (uint256 paid0, uint256 paid1) = abi.decode(poolManager.unlock(abi.encode(key, liquidity)), (uint256, uint256));
        _sweep(key.currency0);
        _sweep(key.currency1);
        poolId = keccak256(abi.encode(key));
        emit Seeded(poolId, sqrtPriceX96, tick, liquidity, paid0, paid1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint128 liquidity) = abi.decode(data, (PoolKey, uint128));
        (int24 lower, int24 upper) = TestnetPoolMath.fullRange(key.tickSpacing);
        (int256 delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), bytes32(0)), ""
        );
        uint256 paid0 = _pay(key.currency0, delta.amount0());
        uint256 paid1 = _pay(key.currency1, delta.amount1());
        return abi.encode(paid0, paid1);
    }

    function _pay(address currency, int128 amount) private returns (uint256 paid) {
        if (amount > 0) revert UnexpectedCredit();
        paid = uint256(int256(-amount));
        if (paid == 0) return 0;
        poolManager.sync(currency);
        IERC20(currency).safeTransfer(address(poolManager), paid);
        poolManager.settle();
    }

    function _sweep(address token) private {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner(), bal);
    }
}
