// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Valuer} from "../../core/Valuer.sol";
import {PerpMarket} from "../../perps/PerpMarket.sol";
import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {AssetValuation} from "../AssetValuation.sol";
import {ISleeve} from "../interfaces/ISleeve.sol";
import {IPerpVenue, IPositionSleeve} from "../interfaces/IPerpVenue.sol";
import {ITreasuryAccount} from "../interfaces/ITreasuryAccount.sol";
import {InHousePerpVenue} from "./InHousePerpVenue.sol";

/// What the sleeve reads from its account besides ITreasuryAccount.
interface INavAccount {
    function navUsd() external view returns (uint256 nav, bool hold);
}

/// Basis carry (spec 2.3): each pair is a lot of a Stock Token the account already holds (bought by the equity
/// desk through the EquitySleeve) plus a perp SHORT of the same underlying for the same number of tokens. The
/// pair is delta-neutral and earns the funding longs pay shorts. Venue equity counts in the basis band.
///
/// Red-team property: there is no short-spot path. The sleeve never touches Stock Tokens (it declares no ERC-20
/// assets and has no transfer of one), the perp side is hard-coded short, and a pair can only be opened against
/// spot the account holds that no other pair claims. A naked short or a long perp is not expressible here.
///
/// Limits checked on every open, besides the PolicyGuard's own rules after the call:
///   - float cap: spot claimed by pairs in one name <= perNameFloatCapBps of the token's totalSupply();
///   - per-venue cap: open pair notional at one venue <= perVenueCapBps of NAV.
///
/// Pairs execute on on-chain venues (InHousePerpVenue). Off-chain venues (Orderly, Arcus) cannot open on-chain,
/// so their basis legs live in the off-chain desk ledger and are checked by the reconciler.
///
/// Desk operations (`run`, called by the account; pulls are USDG only):
///   OP_OPEN_PAIR  (venueIdx, abi.encode(underlying, sizeUsd, collateral, maxSlippageBps)) pull = collateral
///   OP_CLOSE_PAIR (pairId)                                                                 proceeds -> account
///   OP_ADD_MARGIN (pairId, abi.encode(amount))                                             pull = amount
contract BasisSleeve is ISleeve, IPositionSleeve {
    using SafeERC20 for IERC20;

    uint8 public constant OP_OPEN_PAIR = 0;
    uint8 public constant OP_CLOSE_PAIR = 1;
    uint8 public constant OP_ADD_MARGIN = 2;
    uint8 public constant BAND_BASIS = 2;
    uint256 public constant MAX_VENUES = 8;
    uint256 private constant BPS = 10_000;

    struct Pair {
        uint32 venueIdx;
        address underlying;
        uint256 spotRaw; // Stock Token base units of the account's spot claimed by this pair
        uint256 perpTokens; // size of the perp short in token base units (== spotRaw at open)
        uint256 entryMultiplier; // uiMultiplier (1e18) at open
        uint256 entryPriceUsd; // Valuer price per token (1e18) at open
        uint256 collateral; // cash units posted (open + add-margin)
        uint64 openedAt;
        uint64 closedAt; // 0 while open
        int256 cumulativeFundingUsd; // realized at close (USD 1e18): funding net of borrow and fees; + = received
    }

    address public immutable account;
    IERC20 public immutable cash;
    Valuer public immutable valuer;
    uint8 private immutable _cashDecimals;

    IPerpVenue[] private _venues;
    mapping(address venue => bool) public isVenue;
    Pair[] private _pairs;
    mapping(address underlying => uint256) public pairedRaw; // spot claimed by open pairs, per name
    mapping(uint256 venueIdx => mapping(address underlying => uint256)) public openPairOf; // pairId + 1

    event VenueAdded(address indexed venue);
    event PairOpened(uint256 indexed pairId, address indexed underlying, uint256 venueIdx, uint256 tokens, uint256 entryPriceUsd, uint256 entryMultiplier);
    event PairClosed(uint256 indexed pairId, uint256 cashBack, int256 cumulativeFundingUsd);
    event PairMargin(uint256 indexed pairId, uint256 amount);

    error NotAccount();
    error NotBoard();
    error BadVenue();
    error TooManyVenues();
    error UnknownOp(uint8 op);
    error UnknownPair(uint256 pairId);
    error PairClosedAlready(uint256 pairId);
    error PairExists(uint256 pairId);
    error ZeroAmount();
    error PositionNotFlat(address underlying);
    error SpotNotHeld(address underlying, uint256 free, uint256 needed);
    error FloatCapExceeded(address underlying, uint256 paired, uint256 cap);
    error VenueCapExceeded(uint256 venueIdx, uint256 notionalUsd, uint256 capUsd);
    error NotShort();

    constructor(address account_, IERC20 cash_, Valuer valuer_) {
        account = account_;
        cash = cash_;
        valuer = valuer_;
        _cashDecimals = IERC20Metadata(address(cash_)).decimals();
    }

    function addVenue(IPerpVenue venue) external {
        if (msg.sender != ITreasuryAccount(account).board()) revert NotBoard();
        if (address(venue) == address(0) || isVenue[address(venue)] || venue.sleeve() != address(this)) {
            revert BadVenue();
        }
        if (_venues.length >= MAX_VENUES) revert TooManyVenues();
        _venues.push(venue);
        isVenue[address(venue)] = true;
        emit VenueAdded(address(venue));
    }

    // ---------------------------------------------------------------- ISleeve / IPositionSleeve

    function band() external pure returns (uint8) {
        return BAND_BASIS;
    }

    /// No ERC-20 assets: the spot leg stays with the account under the EquitySleeve; this sleeve holds venues.
    function assets() external pure returns (address[] memory assets_, uint8[] memory kinds) {
        return (assets_, kinds);
    }

    function valueOf(address account_) external view returns (uint256 usd, bool hold) {
        if (account_ != account) return (0, false);
        for (uint256 i; i < _venues.length; ++i) {
            (uint256 v, bool stale) = _venues[i].equityOf();
            usd += v;
            hold = hold || stale;
        }
    }

    function isPositionSleeve() external pure returns (bool) {
        return true;
    }

    function venues() external view returns (IPerpVenue[] memory) {
        return _venues;
    }

    // ---------------------------------------------------------------- desk operations

    function run(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != account) revert NotAccount();
        (uint8 op, uint256 idx, bytes memory args) = abi.decode(data, (uint8, uint256, bytes));
        if (op == OP_OPEN_PAIR) return abi.encode(_openPair(idx, args));
        if (op == OP_CLOSE_PAIR) return abi.encode(_closePair(idx));
        if (op == OP_ADD_MARGIN) {
            _addMargin(idx, abi.decode(args, (uint256)));
            return "";
        }
        revert UnknownOp(op);
    }

    function _openPair(uint256 venueIdx, bytes memory args) private returns (uint256 id) {
        (address u, uint256 sizeUsd, uint256 collateral, uint256 slip) =
            abi.decode(args, (address, uint256, uint256, uint256));
        if (sizeUsd == 0 || collateral == 0) revert ZeroAmount();
        IPerpVenue v = _venues[venueIdx];
        uint256 existing = openPairOf[venueIdx][u];
        if (existing != 0) revert PairExists(existing - 1);
        if (_shortTokens(v, u) != 0) revert PositionNotFlat(u); // the venue position must be this pair alone

        cash.safeTransferFrom(account, address(this), collateral);
        cash.forceApprove(address(v), collateral);
        v.depositMargin(collateral);
        cash.forceApprove(address(v), 0);
        v.open(u, false, sizeUsd, collateral, slip);
        uint256 tokens = _shortTokens(v, u);
        if (tokens == 0) revert NotShort();

        _claimSpot(u, tokens);
        id = _record(venueIdx, u, tokens, collateral);
        _checkVenueCap(venueIdx);
    }

    /// Spot leg: unclaimed spot the account holds right now covers the short 1:1, inside the float cap.
    function _claimSpot(address u, uint256 tokens) private {
        uint256 held = IERC20(u).balanceOf(account);
        uint256 claimed = pairedRaw[u];
        uint256 free = held > claimed ? held - claimed : 0;
        if (free < tokens) revert SpotNotHeld(u, free, tokens);
        uint256 paired = claimed + tokens;
        pairedRaw[u] = paired;
        uint256 floatCap = IERC20(u).totalSupply() * _policy().perNameFloatCapBps / BPS;
        if (paired > floatCap) revert FloatCapExceeded(u, paired, floatCap);
    }

    function _record(uint256 venueIdx, address u, uint256 tokens, uint256 collateral) private returns (uint256 id) {
        Valuer.Quote memory q = valuer.quote(u);
        id = _pairs.length;
        Pair storage pr = _pairs.push();
        pr.venueIdx = uint32(venueIdx);
        pr.underlying = u;
        pr.spotRaw = tokens;
        pr.perpTokens = tokens;
        pr.entryMultiplier = q.multiplier;
        pr.entryPriceUsd = q.priceUsdPerToken;
        pr.collateral = collateral;
        pr.openedAt = uint64(block.timestamp);
        openPairOf[venueIdx][u] = id + 1;
        emit PairOpened(id, u, venueIdx, tokens, q.priceUsdPerToken, q.multiplier);
    }

    function _checkVenueCap(uint256 venueIdx) private view {
        (uint256 notional, uint256 nav) = venueNotional(venueIdx);
        uint256 capUsd = nav * _policy().perVenueCapBps / BPS;
        if (notional > capUsd) revert VenueCapExceeded(venueIdx, notional, capUsd);
    }

    function _policy() private view returns (TreasuryPolicy.Policy memory p) {
        (p,,) = ITreasuryAccount(account).policy().current();
    }

    /// Closes the short in full (works off-hours and while stale: it only reduces) and sends every unit of cash
    /// the close freed back to the account. The spot leg stays with the account, unclaimed.
    function _closePair(uint256 id) private returns (uint256 cashBack) {
        Pair storage pr = _pair(id);
        if (pr.closedAt != 0) revert PairClosedAlready(id);
        IPerpVenue v = _venues[pr.venueIdx];
        address u = pr.underlying;
        PerpMarket m = InHousePerpVenue(address(v)).marketOf(u);
        PerpMarket.Position memory pos = m.position(address(v));

        uint256 idle0 = cash.balanceOf(address(v));
        if (pos.size != 0) v.close(u, pos.size);
        cashBack = cash.balanceOf(address(v)) - idle0;
        if (cashBack != 0) v.withdrawMarginToAccount(cashBack);

        // Realized carry = what came back - margin posted - the price move on the short at the exit price.
        (uint256 tokensUsd,) = valuer.value(u, pos.tokens);
        int256 pricePnl = int256(_to1e18(pos.size)) - int256(tokensUsd);
        pr.cumulativeFundingUsd = int256(_to1e18(cashBack)) - int256(_to1e18(pr.collateral)) - pricePnl;
        pr.closedAt = uint64(block.timestamp);
        pairedRaw[u] -= pr.spotRaw;
        delete openPairOf[pr.venueIdx][u];
        emit PairClosed(id, cashBack, pr.cumulativeFundingUsd);
    }

    function _addMargin(uint256 id, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        Pair storage pr = _pair(id);
        if (pr.closedAt != 0) revert PairClosedAlready(id);
        IPerpVenue v = _venues[pr.venueIdx];
        cash.safeTransferFrom(account, address(this), amount);
        cash.forceApprove(address(v), amount);
        v.depositMargin(amount);
        cash.forceApprove(address(v), 0);
        v.open(pr.underlying, false, 0, amount, 0); // size 0: margin only
        pr.collateral += amount;
        emit PairMargin(id, amount);
    }

    // ---------------------------------------------------------------- views

    function pairCount() external view returns (uint256) {
        return _pairs.length;
    }

    function pair(uint256 id) external view returns (Pair memory) {
        return _pair(id);
    }

    /// Signed USD delta (1e18) of one open pair: spot still held for it minus the short, both at the Valuer
    /// price. ~0 for a healthy pair; negative if the account sold spot the pair claims. 0 once closed.
    function pairDelta(uint256 id) public view returns (int256) {
        Pair memory pr = _pair(id);
        if (pr.closedAt != 0) return 0;
        uint256 held = IERC20(pr.underlying).balanceOf(account);
        uint256 spot = pr.spotRaw;
        uint256 others = pairedRaw[pr.underlying] - pr.spotRaw;
        uint256 mine = held > others ? held - others : 0; // other pairs keep their claim first
        if (mine < spot) spot = mine;
        (uint256 spotUsd,) = valuer.value(pr.underlying, spot);
        (uint256 perpUsd,) = valuer.value(pr.underlying, _shortTokens(_venues[pr.venueIdx], pr.underlying));
        return int256(spotUsd) - int256(perpUsd);
    }

    /// Carry so far (USD 1e18): realized at close, or for an open pair the venue position's equity minus margin
    /// minus the price move, i.e. funding received net of borrow and fees.
    function pairCarry(uint256 id) external view returns (int256) {
        Pair memory pr = _pair(id);
        if (pr.closedAt != 0) return pr.cumulativeFundingUsd;
        IPerpVenue v = _venues[pr.venueIdx];
        PerpMarket m = InHousePerpVenue(address(v)).marketOf(pr.underlying);
        PerpMarket.Position memory pos = m.position(address(v));
        int256 equity = m.equityOf(address(v));
        (uint256 tokensUsd,) = valuer.value(pr.underlying, pos.tokens);
        int256 pricePnl = int256(_to1e18(pos.size)) - int256(tokensUsd);
        return _signed1e18(equity) - int256(_to1e18(pr.collateral)) - pricePnl; // posted margin: fees count
    }

    /// Open pair notional at a venue (USD 1e18, short tokens at the Valuer price) and the account's NAV.
    function venueNotional(uint256 venueIdx) public view returns (uint256 notional, uint256 nav) {
        IPerpVenue.Position[] memory pos = _venues[venueIdx].positionOf();
        for (uint256 i; i < pos.length; ++i) {
            if (pos[i].tokens >= 0) continue;
            (uint256 usd,) = valuer.value(pos[i].underlying, uint256(-pos[i].tokens));
            notional += usd;
        }
        (nav,) = INavAccount(account).navUsd();
    }

    // ---------------------------------------------------------------- internals

    function _pair(uint256 id) private view returns (Pair storage) {
        if (id >= _pairs.length) revert UnknownPair(id);
        return _pairs[id];
    }

    /// Short size of `u` at venue `v` in token base units (0 if flat). A long there is never ours.
    function _shortTokens(IPerpVenue v, address u) private view returns (uint256) {
        IPerpVenue.Position[] memory pos = v.positionOf();
        for (uint256 i; i < pos.length; ++i) {
            if (pos[i].underlying != u) continue;
            if (pos[i].tokens > 0) revert NotShort();
            return uint256(-pos[i].tokens);
        }
        return 0;
    }

    function _to1e18(uint256 x) private view returns (uint256) {
        return AssetValuation.to1e18(x, _cashDecimals);
    }

    function _signed1e18(int256 x) private view returns (int256) {
        return x < 0 ? -int256(_to1e18(uint256(-x))) : int256(_to1e18(uint256(x)));
    }
}
