// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// ERC-8056 Stock Token. Shares represented by a balance = balance * uiMultiplier() / 1e18.
interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}
