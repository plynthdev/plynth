// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUnlockCallback, PoolKey, SwapParams} from "../../src/interfaces/IUniswapV4.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory sym, uint8 dec_) ERC20(sym, sym) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// ERC-20 Stock Token with an ERC-8056 style uiMultiplier.
contract MockStockERC20 is MockERC20 {
    uint256 public uiMultiplier = 1e18;

    constructor(string memory sym, uint8 dec_) MockERC20(sym, dec_) {}

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}

/// Test double for the v4 PoolManager: same unlock / swap / sync / settle / take flow and the same
/// "every delta must be zero when unlock returns" rule, with a fixed exchange rate per pool instead of
/// a curve. Rate = currency1 base units per currency0 base unit, 1e18-scaled. Fee in pips (1e6) as in v4.
contract MockPoolManager {
    mapping(bytes32 poolId => uint256) public rate1Per0X18;
    uint256 public fillBps = 10_000; // < 10000 simulates a swap that hits its price limit early

    bool private _unlocked;
    address private _syncedCurrency;
    uint256 private _syncedReserve;
    mapping(address currency => int256) public delta;
    uint256 private _nonzero;

    error AlreadyUnlocked();
    error ManagerLocked();
    error CurrencyNotSettled();
    error OnlyExactInput();

    function setRate(PoolKey memory key, uint256 r) external {
        rate1Per0X18[keccak256(abi.encode(key))] = r;
    }

    mapping(bytes32 slot => bytes32) private _slots;

    /// Stores slot0 (sqrtPriceX96 in the low 160 bits) where the real PoolManager keeps it, for `extsload`.
    function setSqrtPrice(PoolKey memory key, uint160 sqrtPriceX96) external {
        _slots[keccak256(abi.encode(keccak256(abi.encode(key)), bytes32(uint256(6))))] = bytes32(uint256(sqrtPriceX96));
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _slots[slot];
    }

    function setFillBps(uint256 b) external {
        fillBps = b;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (_unlocked) revert AlreadyUnlocked();
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (_nonzero != 0) revert CurrencyNotSettled();
        _unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        if (!_unlocked) revert ManagerLocked();
        if (p.amountSpecified >= 0) revert OnlyExactInput();
        uint256 r = rate1Per0X18[keccak256(abi.encode(key))];
        uint256 amountIn = uint256(-p.amountSpecified) * fillBps / 10_000;
        uint256 afterFee = amountIn * (1e6 - key.fee) / 1e6;
        uint256 out = p.zeroForOne ? afterFee * r / 1e18 : afterFee * 1e18 / r;
        int128 a0;
        int128 a1;
        if (p.zeroForOne) {
            (a0, a1) = (-int128(int256(amountIn)), int128(int256(out)));
            _account(key.currency0, a0);
            _account(key.currency1, a1);
        } else {
            (a0, a1) = (int128(int256(out)), -int128(int256(amountIn)));
            _account(key.currency0, a0);
            _account(key.currency1, a1);
        }
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        _syncedCurrency = currency;
        _syncedReserve = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (!_unlocked) revert ManagerLocked();
        paid = IERC20(_syncedCurrency).balanceOf(address(this)) - _syncedReserve;
        _account(_syncedCurrency, int256(paid));
        _syncedCurrency = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        if (!_unlocked) revert ManagerLocked();
        _account(currency, -int256(amount));
        IERC20(currency).transfer(to, amount);
    }

    function _account(address currency, int256 d) private {
        if (d == 0) return;
        int256 before = delta[currency];
        int256 next = before + d;
        if (before == 0) _nonzero++;
        else if (next == 0) _nonzero--;
        delta[currency] = next;
    }
}
