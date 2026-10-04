// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// One perp venue as seen by a PerpSleeve. Each venue adapter belongs to exactly one sleeve (and so to one
/// TreasuryAccount): it is the trader on its venue, so positions never mix between treasuries.
///
/// - On-chain venues (InHousePerpVenue) do everything here and report positions read straight from the market.
/// - Off-chain venues (Orderly, Arcus: todo 29) only move margin on-chain; `open`/`close` revert and their
///   positions and equity come from the controller-signed PositionMirror.
interface IPerpVenue {
    /// A position in one underlying: `tokens` are Stock Token base units, positive long, negative short.
    struct Position {
        address underlying;
        int256 tokens;
    }

    function sleeve() external view returns (address);

    /// Pulls `amount` of cash (USDG) from the sleeve and posts it as margin at the venue. Only the sleeve.
    function depositMargin(uint256 amount) external;

    /// Sends `amount` of idle cash held by this adapter back to the sleeve's TreasuryAccount. Only the sleeve.
    function withdrawMarginToAccount(uint256 amount) external;

    /// Opens or increases a position (sizeUsd in cash units; sizeUsd == 0 adds margin only). Only the sleeve.
    function open(address underlying, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        external;

    /// Reduces a position by `sizeUsd` (>= size closes it). Proceeds stay idle in the adapter. Only the sleeve.
    function close(address underlying, uint256 sizeUsd) external;

    function positionOf() external view returns (Position[] memory);

    /// Venue equity in USD (1e18): idle cash + margin + unrealized PnL, floored at 0 per position.
    /// `stale` is true when the numbers cannot be trusted for new risk (an old or missing mirror snapshot).
    function equityOf() external view returns (uint256 usd, bool stale);
}

/// A sleeve whose value lives at perp venues instead of in ERC-20 balances of the account. The PolicyGuard
/// reads its venues directly (rules 5-6) and counts their equity in NAV under the sleeve's band.
interface IPositionSleeve {
    function isPositionSleeve() external pure returns (bool);
    function account() external view returns (address);
    function venues() external view returns (IPerpVenue[] memory);
}
