// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Valuer} from "../../core/Valuer.sol";
import {AssetValuation} from "../AssetValuation.sol";
import {ISleeve} from "../interfaces/ISleeve.sol";

/// Cash band adapter: USDG held directly plus shares of allow-listed ERC-4626 vaults over USDG.
///
/// Stateless: it pulls exactly what the account approved, deposits or redeems, and every result goes back
/// to the caller in the same call. The vault list is fixed at deploy because the account and the guard read
/// `assets()` on every operation and a changed list is rejected as an unknown change.
contract CashSleeve is ISleeve {
    using SafeERC20 for IERC20;

    uint8 public constant OP_DEPOSIT = 0; // amount = USDG in, minOut = min shares
    uint8 public constant OP_REDEEM = 1; // amount = shares in, minOut = min USDG
    uint256 public constant MAX_VAULTS = 15; // + USDG = TreasuryAccount.MAX_ASSETS_PER_SLEEVE

    Valuer public immutable valuer;
    IERC20 public immutable usdg;

    address[] private _assets;
    uint8[] private _kinds;
    mapping(address vault => bool) public isVault;

    error ZeroAddress();
    error TooManyVaults();
    error DuplicateVault(address vault);
    error WrongUnderlying(address vault);
    error UnknownVault(address vault);
    error UnknownOp(uint8 op);
    error ZeroAmount();
    error MinOut(uint256 minOut, uint256 got);
    error Residual(address token);

    constructor(Valuer valuer_, IERC20 usdg_, IERC4626[] memory vaults) {
        if (address(valuer_) == address(0) || address(usdg_) == address(0)) revert ZeroAddress();
        if (vaults.length > MAX_VAULTS) revert TooManyVaults();
        valuer = valuer_;
        usdg = usdg_;
        _assets.push(address(usdg_));
        _kinds.push(AssetValuation.KIND_CASH);
        for (uint256 i; i < vaults.length; ++i) {
            address v = address(vaults[i]);
            if (v == address(0)) revert ZeroAddress();
            if (isVault[v]) revert DuplicateVault(v);
            if (vaults[i].asset() != address(usdg_)) revert WrongUnderlying(v);
            isVault[v] = true;
            _assets.push(v);
            _kinds.push(AssetValuation.KIND_CASH_VAULT);
        }
    }

    function band() external pure returns (uint8) {
        return 0;
    }

    function assets() external view returns (address[] memory, uint8[] memory) {
        return (_assets, _kinds);
    }

    /// The allow-listed vaults (assets() minus USDG).
    function vaults() external view returns (address[] memory v) {
        v = new address[](_assets.length - 1);
        for (uint256 i = 1; i < _assets.length; ++i) v[i - 1] = _assets[i];
    }

    /// USDG balance + sum of convertToAssets(shares), in USD 1e18 (the same path the PolicyGuard uses).
    function valueOf(address account) external view returns (uint256 usd, bool hold) {
        for (uint256 i; i < _assets.length; ++i) {
            (uint256 v, bool h) =
                AssetValuation.value(valuer, _assets[i], _kinds[i], IERC20(_assets[i]).balanceOf(account));
            usd += v;
            hold = hold || h;
        }
    }

    /// data = abi.encode(uint8 op, address vault, uint256 amount, uint256 minOut). Returns abi.encode(out).
    function run(bytes calldata data) external returns (bytes memory) {
        (uint8 op, address vault, uint256 amount, uint256 minOut) = abi.decode(data, (uint8, address, uint256, uint256));
        if (!isVault[vault]) revert UnknownVault(vault);
        if (amount == 0) revert ZeroAmount();
        uint256 usdg0 = usdg.balanceOf(address(this));
        uint256 shares0 = IERC20(vault).balanceOf(address(this));
        uint256 out;
        if (op == OP_DEPOSIT) {
            usdg.safeTransferFrom(msg.sender, address(this), amount);
            usdg.forceApprove(vault, amount);
            out = IERC4626(vault).deposit(amount, msg.sender);
            usdg.forceApprove(vault, 0);
        } else if (op == OP_REDEEM) {
            IERC20(vault).safeTransferFrom(msg.sender, address(this), amount);
            out = IERC4626(vault).redeem(amount, msg.sender, address(this));
        } else {
            revert UnknownOp(op);
        }
        if (out < minOut) revert MinOut(minOut, out);
        // Nothing may stay behind in the adapter (a vault that pulls less than asked would strand USDG).
        if (usdg.balanceOf(address(this)) != usdg0) revert Residual(address(usdg));
        if (IERC20(vault).balanceOf(address(this)) != shares0) revert Residual(vault);
        return abi.encode(out);
    }
}
