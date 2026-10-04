// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// ERC-6538 stealth meta-address registry (0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538 on 4663 and 46630).
interface IERC6538Registry {
    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external;
    function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes memory);
}
