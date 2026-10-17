// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISleeve} from "../../interfaces/ISleeve.sol";
import {IPerpVenue, IPositionSleeve} from "../../interfaces/IPerpVenue.sol";
import {ITreasuryAccount} from "../../interfaces/ITreasuryAccount.sol";
import {AdapterGate} from "../../libs/AdapterGate.sol";

/// The perp sleeve of ONE TreasuryAccount (hedge overlay or basis carry). Its value lives at perp venues, behind
/// one `IPerpVenue` interface each, so it declares no ERC-20 assets; the PolicyGuard reads the venues itself
/// (equity into NAV under this sleeve's band, positions into net delta and leverage, venue caps and allow-list).
///
/// Desk operations (`run`, called by the account with exact approvals):
///   OP_DEPOSIT  (venueIdx, abi.encode(amount))                                   cash account -> venue margin
///   OP_WITHDRAW (venueIdx, abi.encode(amount))                                   idle venue cash -> account
///   OP_OPEN     (venueIdx, abi.encode(underlying, isLong, sizeUsd, collateral, maxSlippageBps))
///   OP_CLOSE    (venueIdx, abi.encode(underlying, sizeUsd))
/// The board adds venues; a venue is never removed, so whatever it holds stays in NAV.
contract PerpSleeve is ISleeve, IPositionSleeve {
    using SafeERC20 for IERC20;

    uint8 public constant OP_DEPOSIT = 0;
    uint8 public constant OP_WITHDRAW = 1;
    uint8 public constant OP_OPEN = 2;
    uint8 public constant OP_CLOSE = 3;
    uint256 public constant MAX_VENUES = 8;

    address public immutable account;
    IERC20 public immutable cash;
    uint8 private immutable _band;

    IPerpVenue[] private _venues;
    mapping(address venue => bool) public isVenue;

    event VenueAdded(address indexed venue);
    event VenueProposed(address indexed venue, uint64 eta);

    error NotAccount();
    error NotBoard();
    error BadBand();
    error BadVenue();
    error TooManyVenues();
    error UnknownOp(uint8 op);

    /// `band_`: 0 cash (hedge margin counts as cash), 2 basis (carry trade). Equity (1) is for spot only.
    constructor(address account_, IERC20 cash_, uint8 band_) {
        if (band_ != 0 && band_ != 2) revert BadBand();
        account = account_;
        cash = cash_;
        _band = band_;
    }

    /// venue => when `addVenue` may take it (0 = not proposed).
    mapping(address venue => uint64) public venueEta;

    /// Starts the account's policy TIMELOCK for a venue (it must be on the factory allow-list).
    function proposeVenue(IPerpVenue venue) external {
        if (msg.sender != ITreasuryAccount(account).board()) revert NotBoard();
        emit VenueProposed(address(venue), AdapterGate.propose(venueEta, account, address(venue)));
    }

    /// The board adds a venue: during the account's setup window at once, after it only a proposed venue whose
    /// TIMELOCK has passed; on a factory treasury only an allow-listed one (AdapterGate).
    function addVenue(IPerpVenue venue) external {
        if (msg.sender != ITreasuryAccount(account).board()) revert NotBoard();
        AdapterGate.apply_(venueEta, account, address(venue));
        if (address(venue) == address(0) || isVenue[address(venue)] || venue.sleeve() != address(this)) {
            revert BadVenue();
        }
        if (_venues.length >= MAX_VENUES) revert TooManyVenues();
        _venues.push(venue);
        isVenue[address(venue)] = true;
        emit VenueAdded(address(venue));
    }

    // ---------------------------------------------------------------- ISleeve

    function band() external view returns (uint8) {
        return _band;
    }

    function assets() external pure returns (address[] memory assets_, uint8[] memory kinds) {
        return (assets_, kinds);
    }

    /// Sum of venue equity (USD 1e18); `hold` if any venue is stale.
    function valueOf(address account_) external view returns (uint256 usd, bool hold) {
        if (account_ != account) return (0, false);
        for (uint256 i; i < _venues.length; ++i) {
            (uint256 v, bool stale) = _venues[i].equityOf();
            usd += v;
            hold = hold || stale;
        }
    }

    function run(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != account) revert NotAccount();
        (uint8 op, uint256 idx, bytes memory args) = abi.decode(data, (uint8, uint256, bytes));
        IPerpVenue v = _venues[idx];
        if (op == OP_DEPOSIT) {
            uint256 amount = abi.decode(args, (uint256));
            cash.safeTransferFrom(account, address(this), amount);
            cash.forceApprove(address(v), amount);
            v.depositMargin(amount);
            cash.forceApprove(address(v), 0);
        } else if (op == OP_WITHDRAW) {
            v.withdrawMarginToAccount(abi.decode(args, (uint256)));
        } else if (op == OP_OPEN) {
            (address u, bool isLong, uint256 sizeUsd, uint256 coll, uint256 slip) =
                abi.decode(args, (address, bool, uint256, uint256, uint256));
            v.open(u, isLong, sizeUsd, coll, slip);
        } else if (op == OP_CLOSE) {
            (address u, uint256 sizeUsd) = abi.decode(args, (address, uint256));
            v.close(u, sizeUsd);
        } else {
            revert UnknownOp(op);
        }
        return "";
    }

    // ---------------------------------------------------------------- IPositionSleeve

    function isPositionSleeve() external pure returns (bool) {
        return true;
    }

    function venues() external view returns (IPerpVenue[] memory) {
        return _venues;
    }
}
