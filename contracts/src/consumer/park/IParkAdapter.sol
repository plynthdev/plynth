// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Where Hidden Vault USDG can be parked to earn yield (todo 25). A park position is a note of `shareToken()`
/// inside the ShieldedPool, so an adapter's share token must be a plain ERC-20 the pool can hold and withdraw.
///
/// Both moves pull from msg.sender (approve first) and pay `to` in the same call; an adapter never keeps a
/// balance between calls and has no owner. `unpark` is open to any share holder, so park shares withdrawn from
/// the pool as shares can always be redeemed directly.
interface IParkAdapter {
    /// The parked asset (USDG).
    function asset() external view returns (address);

    /// The ERC-20 a park position is held in.
    function shareToken() external view returns (address);

    /// Pulls `assets` of `asset()` from msg.sender and sends the shares it buys to `to`.
    function park(uint256 assets, address to) external returns (uint256 shares);

    /// Takes `shares` of `shareToken()` from msg.sender and sends the assets they redeem for to `to`.
    function unpark(uint256 shares, address to) external returns (uint256 assets);

    /// Current value of `shares` in `asset()` base units (rounded down), for display.
    function convertToAssets(uint256 shares) external view returns (uint256);
}
