// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AssetValuation} from "../../libs/AssetValuation.sol";
import {PositionMirror} from "../PositionMirror.sol";
import {IPerpVenue, IPositionSleeve} from "../../interfaces/IPerpVenue.sol";

/// An off-chain venue (order book run by someone else) as seen on-chain: margin moves on-chain, trading does not.
/// Deposits go to the venue's `custody` (its vault or deposit address; todo 29 specialises the call per venue)
/// and are counted in `flowIn`. Withdrawals requested off-chain arrive back here as idle cash and are swept to
/// the account; `flowOut` = idle cash here + everything swept so far = all cash ever received back. Positions and
/// venue equity come from the controller-signed PositionMirror.
///
/// at venue = mirror.equityUsd + (flowIn - flowInSeen) - (flowOut - flowOutSeen), floored at 0
/// equity   = at venue + idle cash here
/// so cash the venue sent back is counted once: at the adapter (or, once swept, in the account) and no longer at
/// the venue, even before the next snapshot sees it leave. A transfer to the adapter raises flowOut and idle
/// equally and changes nothing; a `flowOutSeen` above `flowOut` is clamped.
contract MirroredPerpVenue is IPerpVenue {
    using SafeERC20 for IERC20;

    address public immutable sleeve;
    IERC20 public immutable cash;
    PositionMirror public immutable mirror;
    address public immutable custody;
    uint8 private immutable _cashDecimals;

    /// Cumulative cash deposited to the venue (cash units).
    uint256 public flowIn;
    /// Cumulative cash swept from here to the account (cash units).
    uint256 public swept;

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
        swept += amount;
        cash.safeTransfer(IPositionSleeve(sleeve).account(), amount);
    }

    /// Cumulative cash received back from the venue (cash units): idle here plus everything swept.
    function flowOut() public view returns (uint256) {
        return cash.balanceOf(address(this)) + swept;
    }

    /// Orders are placed through the venue's API by the desks (todo 29), never on-chain.
    function open(address, bool, uint256, uint256, uint256) external pure {
        revert OffChainVenue();
    }

    function close(address, uint256) external pure {
        revert OffChainVenue();
    }

    /// The mirror's positions; the venue account is cross-margined, so each position's margin is the equity at the
    /// venue (see the contract notes: mirror equity, plus deposits it has not seen, less returns it has not seen).
    function positionOf() external view returns (Position[] memory positions) {
        (PositionMirror.Position[] memory m,,,,) = mirror.latest(address(this));
        uint256 margin = _atVenueUsd();
        positions = new Position[](m.length);
        for (uint256 i; i < m.length; ++i) {
            positions[i] = Position(m[i].underlying, m[i].tokens, margin);
        }
    }

    function equityOf() external view returns (uint256 usd, bool stale) {
        usd = _atVenueUsd() + AssetValuation.to1e18(cash.balanceOf(address(this)), _cashDecimals);
        stale = mirror.isStale(address(this));
    }

    function _atVenueUsd() private view returns (uint256) {
        (, uint256 eq, uint256 seenIn, uint256 seenOut,) = mirror.latest(address(this));
        uint256 out = flowOut();
        if (seenOut > out) seenOut = out;
        uint256 unseenIn = flowIn > seenIn ? flowIn - seenIn : 0;
        uint256 plus = eq + AssetValuation.to1e18(unseenIn, _cashDecimals);
        uint256 minus = AssetValuation.to1e18(out - seenOut, _cashDecimals);
        return plus > minus ? plus - minus : 0;
    }
}
