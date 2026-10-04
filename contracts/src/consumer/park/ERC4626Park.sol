// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParkAdapter} from "../../interfaces/IParkAdapter.sol";

/// Parks USDG in one ERC-4626 vault (e.g. Steakhouse USDG, a Morpho Vault V2 on 4663; see chain-facts).
/// The vault's own share token is the park note asset. Which vaults are usable is decided by ShieldedTrade's
/// timelocked adapter allow-list, one adapter per vault.
contract ERC4626Park is IParkAdapter {
    using SafeERC20 for IERC20;

    IERC4626 public immutable vault;
    IERC20 private immutable _asset;

    error ZeroAddress();
    error WrongAsset(address vaultAsset, address expected);
    error ZeroAmount();

    constructor(IERC4626 vault_, address usdg) {
        if (address(vault_) == address(0) || usdg == address(0)) revert ZeroAddress();
        address a = vault_.asset();
        if (a != usdg) revert WrongAsset(a, usdg);
        vault = vault_;
        _asset = IERC20(usdg);
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function shareToken() external view returns (address) {
        return address(vault);
    }

    function park(uint256 assets, address to) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        _asset.forceApprove(address(vault), assets);
        shares = vault.deposit(assets, to);
        _asset.forceApprove(address(vault), 0);
    }

    /// Redeems msg.sender's shares (msg.sender must have approved this adapter on the vault).
    function unpark(uint256 shares, address to) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        assets = vault.redeem(shares, to, msg.sender);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return vault.convertToAssets(shares);
    }
}
