// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Valuer} from "../core/Valuer.sol";

/// One valuation path for every treasury asset, shared by the PolicyGuard and the sleeves, so the guard's
/// NAV and the account's NAV agree to the wei. All values are USD with 18 decimals.
///
/// - Cash (a dollar stablecoin, USDG): 1 token = 1 USD, scaled by its decimals.
/// - Cash vault (ERC-4626 over a dollar stablecoin): `convertToAssets(shares)`, then as cash.
/// - Stock Token: the Valuer (Chainlink price per token, multiplier applied once); a stale feed sets `hold`.
///   A token that is no longer canonical in the registry is worth 0 and on hold.
library AssetValuation {
    uint8 internal constant KIND_CASH = 0;
    uint8 internal constant KIND_CASH_VAULT = 1;
    uint8 internal constant KIND_STOCK_TOKEN = 2;

    error UnknownKind(uint8 kind);

    function value(Valuer valuer, address asset, uint8 kind, uint256 raw)
        internal
        view
        returns (uint256 usd, bool hold)
    {
        if (raw == 0) return (0, false);
        if (kind == KIND_CASH) return (to1e18(raw, IERC20Metadata(asset).decimals()), false);
        if (kind == KIND_CASH_VAULT) {
            address underlying = IERC4626(asset).asset();
            uint256 assets = IERC4626(asset).convertToAssets(raw);
            return (to1e18(assets, IERC20Metadata(underlying).decimals()), false);
        }
        if (kind == KIND_STOCK_TOKEN) {
            // A delisted (non-canonical) token has no trusted price: count it as 0 and on hold, so it never
            // inflates NAV and only risk-reducing operations (selling it) remain possible.
            if (!valuer.registry().isCanonical(asset)) return (0, true);
            return valuer.value(asset, raw);
        }
        revert UnknownKind(kind);
    }

    function to1e18(uint256 x, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return x;
        if (dec < 18) return x * 10 ** (18 - dec);
        return x / 10 ** (dec - 18);
    }
}
