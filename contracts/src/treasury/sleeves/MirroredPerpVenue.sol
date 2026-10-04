// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AssetValuation} from "../../libs/AssetValuation.sol";
import {PositionMirror} from "../PositionMirror.sol";
import {IPerpVenue, IPositionSleeve} from "../../interfaces/IPerpVenue.sol";

/// An off-chain venue (order book run by someone else) as seen on-chain: margin moves on-chain, trading does not.
/// Deposits go to the venue's `custody` (its vault or deposit address; todo 29 specialises the call per venue)
/// and are counted in `flowIn`. Withdrawals requested off-chain arrive back here as idle cash and are swept to
/// the account. Positions and venue equity come from the controller-signed PositionMirror.
///
/// equity = mirror.equityUsd + (flowIn - mirror.flowInSeen) + idle cash here.
contract MirroredPerpVenue is IPerpVenue {
    using SafeERC20 for IERC20;

    address public immutable sleeve;
    IERC20 public immutable cash;
    PositionMirror public immutable mirror;
    address public immutable custody;
    uint8 private immutable _cashDecimals;

    /// Cumulative cash deposited to the venue (cash units).
    uint256 public flowIn;

    error NotSleeve();
    error OffChainVenue();
    error ZeroAddress();

    constructor(address sleeve_, IERC20 cash_, PositionMirror mirror_, address custody_) {
        if (sleeve_ == address(0) || address(mirror_) == address(0) || custody_ == address(0)) revert ZeroAddress();
        sleeve = sleeve_;
        cash = cash_;
        mirror = mirror_;
        custody = custody_;
        _cashDecimals = IERC20Metadata(address(cash_)).decimals();
    }

    modifier onlySleeve() {
        if (msg.sender != sleeve) revert NotSleeve();
        _;
    }

    function depositMargin(uint256 amount) external onlySleeve {
        cash.safeTransferFrom(sleeve, custody, amount);
        flowIn += amount;
    }

    function withdrawMarginToAccount(uint256 amount) external onlySleeve {
        cash.safeTransfer(IPositionSleeve(sleeve).account(), amount);
    }

    /// Orders are placed through the venue's API by the desks (todo 29), never on-chain.
    function open(address, bool, uint256, uint256, uint256) external pure {
        revert OffChainVenue();
    }

    function close(address, uint256) external pure {
        revert OffChainVenue();
    }

    function positionOf() external view returns (Position[] memory positions) {
        (positions,,,) = mirror.latest(address(this));
    }

    function equityOf() external view returns (uint256 usd, bool stale) {
        (, uint256 eq, uint256 seen,) = mirror.latest(address(this));
        uint256 unseen = flowIn > seen ? flowIn - seen : 0;
        uint256 idle = cash.balanceOf(address(this));
        usd = eq + AssetValuation.to1e18(unseen + idle, _cashDecimals);
        stale = mirror.isStale(address(this));
    }
}
