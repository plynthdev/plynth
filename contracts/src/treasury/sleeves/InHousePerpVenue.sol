// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PerpPool} from "../../perps/PerpPool.sol";
import {PerpMarket} from "../../perps/PerpMarket.sol";
import {AssetValuation} from "../AssetValuation.sol";
import {IPerpVenue, IPositionSleeve} from "../interfaces/IPerpVenue.sol";

/// The in-house perp pool engine (todo 20) as a venue: fully on-chain, so positions and equity are read straight
/// from the markets and are never stale. This adapter is the trader (one position per market), and margin
/// that is not posted to a position sits idle here until it is withdrawn to the account.
contract InHousePerpVenue is IPerpVenue {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MARKETS = 16;

    address public immutable sleeve;
    PerpPool public immutable pool;
    IERC20 public immutable cash;
    uint8 private immutable _cashDecimals;

    PerpMarket[] private _markets;
    mapping(address underlying => PerpMarket) public marketOf;

    error NotSleeve();
    error BadMarket();
    error UnknownUnderlying(address underlying);
    error SideMismatch();

    constructor(address sleeve_, PerpPool pool_, PerpMarket[] memory markets_) {
        if (markets_.length > MAX_MARKETS) revert BadMarket();
        sleeve = sleeve_;
        pool = pool_;
        cash = IERC20(pool_.asset());
        _cashDecimals = IERC20Metadata(pool_.asset()).decimals();
        for (uint256 i; i < markets_.length; ++i) {
            PerpMarket m = markets_[i];
            if (m.pool() != pool_ || !pool_.isMarket(address(m))) revert BadMarket();
            address u = m.underlying();
            if (address(marketOf[u]) != address(0)) revert BadMarket();
            marketOf[u] = m;
            _markets.push(m);
        }
    }

    modifier onlySleeve() {
        if (msg.sender != sleeve) revert NotSleeve();
        _;
    }

    function depositMargin(uint256 amount) external onlySleeve {
        cash.safeTransferFrom(sleeve, address(this), amount);
    }

    function withdrawMarginToAccount(uint256 amount) external onlySleeve {
        cash.safeTransfer(IPositionSleeve(sleeve).account(), amount);
    }

    function open(address underlying, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        external
        onlySleeve
    {
        PerpMarket m = _market(underlying);
        cash.forceApprove(address(pool), collateral);
        PerpMarket.Position memory p = m.position(address(this));
        if (p.size == 0) {
            m.open(isLong, sizeUsd, collateral, maxSlippageBps);
        } else {
            if (p.isLong != isLong) revert SideMismatch();
            m.increase(sizeUsd, collateral, maxSlippageBps);
        }
        cash.forceApprove(address(pool), 0);
    }

    function close(address underlying, uint256 sizeUsd) external onlySleeve {
        _market(underlying).decrease(sizeUsd);
    }

    // ---------------------------------------------------------------- views

    function positionOf() external view returns (Position[] memory out) {
        uint256 n;
        Position[] memory tmp = new Position[](_markets.length);
        for (uint256 i; i < _markets.length; ++i) {
            PerpMarket.Position memory p = _markets[i].position(address(this));
            if (p.size == 0) continue;
            tmp[n++] = Position(_markets[i].underlying(), p.isLong ? int256(p.tokens) : -int256(p.tokens));
        }
        out = new Position[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    /// Idle cash plus each position's equity (collateral + PnL - funding - borrow) floored at 0: a position
    /// below zero is bad debt the pool absorbs, not a liability of the treasury.
    function equityOf() external view returns (uint256 usd, bool stale) {
        uint256 raw = cash.balanceOf(address(this));
        for (uint256 i; i < _markets.length; ++i) {
            int256 e = _markets[i].equityOf(address(this));
            if (e > 0) raw += uint256(e);
        }
        return (AssetValuation.to1e18(raw, _cashDecimals), false);
    }

    function markets() external view returns (PerpMarket[] memory) {
        return _markets;
    }

    function _market(address underlying) private view returns (PerpMarket m) {
        m = marketOf[underlying];
        if (address(m) == address(0)) revert UnknownUnderlying(underlying);
    }
}
