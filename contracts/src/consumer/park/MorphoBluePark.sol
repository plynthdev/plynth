// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IParkAdapter} from "../../interfaces/IParkAdapter.sol";
import {IIrm, IMorphoBlue, Market, MarketParams} from "../../interfaces/IMorphoBlue.sol";

/// Parks USDG as a lender in one Morpho Blue market (USDG = loan token). The adapter is the Morpho position's
/// owner and mints itself as an ERC-20, one token per Morpho supply share, to whoever parks; burning tokens
/// withdraws exactly those supply shares. So token supply == the adapter's Morpho supply shares at all times,
/// and every holder (the ShieldedPool, or anyone who withdrew park shares from it) redeems pro rata.
///
/// Morpho supply shares start at 1e6 per asset unit (virtual shares), so decimals() = USDG decimals + 6.
/// A withdraw can revert when the market is fully borrowed; the shares then stay redeemable later (or can be
/// withdrawn from the pool as shares and redeemed here directly by their holder).
contract MorphoBluePark is ERC20, IParkAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IMorphoBlue public immutable morpho;
    bytes32 public immutable marketId;
    IERC20 private immutable _loan;
    address private immutable _collateral;
    address private immutable _oracle;
    address private immutable _irm;
    uint256 private immutable _lltv;
    uint8 private immutable _decimals;

    error ZeroAddress();
    error WrongLoanToken(address loanToken, address expected);
    error UnknownMarket(bytes32 id);
    error ZeroAmount();

    constructor(IMorphoBlue morpho_, MarketParams memory params, address usdg)
        ERC20("Plynth Morpho Blue park share", "pkMORPHO")
    {
        if (address(morpho_) == address(0) || usdg == address(0)) revert ZeroAddress();
        if (params.loanToken != usdg) revert WrongLoanToken(params.loanToken, usdg);
        bytes32 id = keccak256(abi.encode(params));
        (,,,, uint128 lastUpdate,) = morpho_.market(id);
        if (lastUpdate == 0) revert UnknownMarket(id);
        morpho = morpho_;
        marketId = id;
        _loan = IERC20(usdg);
        _collateral = params.collateralToken;
        _oracle = params.oracle;
        _irm = params.irm;
        _lltv = params.lltv;
        _decimals = IERC20Metadata(usdg).decimals() + 6;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function marketParams() public view returns (MarketParams memory) {
        return MarketParams(address(_loan), _collateral, _oracle, _irm, _lltv);
    }

    function asset() external view returns (address) {
        return address(_loan);
    }

    function shareToken() external view returns (address) {
        return address(this);
    }

    function park(uint256 assets, address to) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        _loan.safeTransferFrom(msg.sender, address(this), assets);
        _loan.forceApprove(address(morpho), assets);
        (, shares) = morpho.supply(marketParams(), assets, 0, address(this), "");
        _loan.forceApprove(address(morpho), 0);
        _mint(to, shares);
    }

    /// Burns msg.sender's tokens and withdraws the same number of Morpho supply shares to `to`.
    function unpark(uint256 shares, address to) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        _burn(msg.sender, shares);
        (assets,) = morpho.withdraw(marketParams(), 0, shares, address(this), to);
    }

    /// Morpho's own share price including interest accrued since the market's last update
    /// (MorphoBalancesLib.expectedMarketBalances), rounded down like a withdraw.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        (uint256 supplyAssets, uint256 supplyShares) = expectedSupply();
        return Math.mulDiv(shares, supplyAssets + VIRTUAL_ASSETS, supplyShares + VIRTUAL_SHARES);
    }

    /// Market supply assets and shares as they would be after `accrueInterest` now.
    function expectedSupply() public view returns (uint256 supplyAssets, uint256 supplyShares) {
        Market memory m;
        (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee) =
            morpho.market(marketId);
        supplyAssets = m.totalSupplyAssets;
        supplyShares = m.totalSupplyShares;
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0 || m.totalBorrowAssets == 0 || _irm == address(0)) return (supplyAssets, supplyShares);
        uint256 rate = IIrm(_irm).borrowRateView(marketParams(), m);
        uint256 interest = Math.mulDiv(m.totalBorrowAssets, _wTaylorCompounded(rate, elapsed), WAD);
        supplyAssets += interest;
        if (m.fee != 0) {
            uint256 feeAmount = Math.mulDiv(interest, m.fee, WAD);
            supplyShares += Math.mulDiv(feeAmount, supplyShares + VIRTUAL_SHARES, supplyAssets - feeAmount + VIRTUAL_ASSETS);
        }
    }

    /// Value of all park shares held by `holder`.
    function assetsOf(address holder) external view returns (uint256) {
        return convertToAssets(balanceOf(holder));
    }

    // e^(x n) - 1 to the third order, as Morpho's MathLib.wTaylorCompounded.
    function _wTaylorCompounded(uint256 x, uint256 n) private pure returns (uint256) {
        uint256 first = x * n;
        uint256 second = Math.mulDiv(first, first, 2 * WAD);
        uint256 third = Math.mulDiv(second, first, 3 * WAD);
        return first + second + third;
    }
}
