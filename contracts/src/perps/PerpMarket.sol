// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Valuer} from "../core/Valuer.sol";
import {PerpPool} from "./PerpPool.sol";

/// One oracle-priced pool perp per Stock Token (GMX-v1 style), isolated margin, USDG collateral, the
/// PerpPool LPs as counterparty. One position per account.
///
/// Units: sizes, collateral, fees and PnL are in pool-asset units (USDG, 6 dp, 1 USDG = 1 USD). Price is
/// `Valuer.quote(underlying).priceUsdPerToken` (1e18, per TOKEN, multiplier applied exactly once), and a
/// position is held in TOKENS (`tokens`, token base units), so a short of N tokens hedges N tokens 1:1
/// and a later multiplier change moves PnL only as much as it moves the token's price.
///
/// Hold (stale / off-hours / delisted feed): open and increase revert; decrease, close and adding margin
/// work at the last price, with `offHoursSpreadBps` against the trader on decrease/close. Never trap a trader.
///
/// Funding: rate/s = fundingK x (longOI - shortOI) / poolLiquid, heavier side pays, lighter side receives
/// pro rata (only while both sides are open). Borrow fee `borrowBpsPerHour` on size goes to LPs.
/// A realization's net profit (PnL - funding - borrow) is capped at size x maxProfitBps, which is the
/// reserve the pool holds for it.
contract PerpMarket is Ownable2Step, ReentrancyGuard {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 50;
    uint256 public constant MAINTENANCE_BPS = 100;
    uint256 internal constant WAD = 1e18;

    struct Position {
        uint256 size; // notional at entry, asset units
        uint256 collateral; // asset units
        uint256 tokens; // token base units
        bool isLong;
        int256 fundingIndex; // side index at last settle
        uint256 borrowIndex; // borrow index at last settle
        int256 accruedFunding; // + owes, - receives (asset units), not yet realized
        uint256 accruedBorrow; // asset units, not yet realized
    }

    struct Side {
        uint256 size;
        uint256 tokens;
        uint256 collateral;
    }

    PerpPool public immutable pool;
    Valuer public immutable valuer;
    address public immutable underlying;
    /// asset units x ONE / price(1e18) = token units
    uint256 public immutable ONE;

    uint256 public takerFeeBps = 10;
    uint256 public makerFeeBps = 2;
    uint256 public offHoursSpreadBps = 50;
    uint256 public borrowBpsPerHour = 1;
    uint256 public fundingK = 2.78e11; // ~0.1%/h when skew equals the pool
    uint256 public oiCapBps = 2_000; // per side, of pool liquid assets
    uint256 public maxProfitBps = 10_000;
    uint256 public liquidationFee = 5e6;

    Side public longs;
    Side public shorts;
    int256 public longFundingIndex;
    int256 public shortFundingIndex;
    uint256 public borrowIndex;
    uint256 public lastAccrual;
    uint256 public lastPrice;
    /// Index-level funding totals (asset units x 1e18): conservation check, paid >= received, diff is dust.
    uint256 public fundingPaidTotal;
    uint256 public fundingReceivedTotal;

    mapping(address account => Position) internal _positions;

    event Opened(address indexed account, address indexed by, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 price, uint256 fee);
    event Increased(address indexed account, address indexed by, uint256 sizeUsd, uint256 collateral, uint256 price, uint256 fee);
    event Decreased(address indexed account, address indexed by, uint256 sizeUsd, int256 pnl, int256 funding, uint256 borrow, uint256 fee, uint256 payout, uint256 price);
    event Liquidated(address indexed account, address indexed by, uint256 size, int256 equity, uint256 reward, uint256 price);
    event FundingAccrued(int256 longIndex, int256 shortIndex, uint256 borrowIndex);
    event ParamsSet(uint256 takerFeeBps, uint256 makerFeeBps, uint256 offHoursSpreadBps, uint256 borrowBpsPerHour, uint256 fundingK, uint256 oiCapBps, uint256 maxProfitBps, uint256 liquidationFee);

    error NotAuthorized();
    error Hold();
    error NoPosition();
    error HasPosition();
    error ZeroSize();
    error SlippageExceeded(uint256 costBps, uint256 maxBps);
    error Leverage();
    error Liquidatable();
    error NotLiquidatable();
    error OiCap();
    error CollateralTooLow();
    error BadParams();

    constructor(PerpPool pool_, Valuer valuer_, address underlying_, address owner_) Ownable(owner_) {
        pool = pool_;
        valuer = valuer_;
        underlying = underlying_;
        uint8 assetDec = IERC20Metadata(pool_.asset()).decimals();
        ONE = 10 ** (18 - assetDec) * 10 ** IERC20Metadata(underlying_).decimals();
        lastAccrual = block.timestamp;
        (lastPrice,) = _quote();
    }

    // ---------------------------------------------------------------- admin

    function setParams(
        uint256 takerFeeBps_,
        uint256 makerFeeBps_,
        uint256 offHoursSpreadBps_,
        uint256 borrowBpsPerHour_,
        uint256 fundingK_,
        uint256 oiCapBps_,
        uint256 maxProfitBps_,
        uint256 liquidationFee_
    ) external onlyOwner {
        if (
            takerFeeBps_ > 100 || makerFeeBps_ > takerFeeBps_ || offHoursSpreadBps_ > 500 || borrowBpsPerHour_ > 100
                || fundingK_ > 1e14 || oiCapBps_ > BPS || maxProfitBps_ < MAINTENANCE_BPS || maxProfitBps_ > 10 * BPS
        ) revert BadParams();
        _accrue();
        (takerFeeBps, makerFeeBps, offHoursSpreadBps, borrowBpsPerHour) =
            (takerFeeBps_, makerFeeBps_, offHoursSpreadBps_, borrowBpsPerHour_);
        (fundingK, oiCapBps, maxProfitBps, liquidationFee) = (fundingK_, oiCapBps_, maxProfitBps_, liquidationFee_);
        if (pool.isMarket(address(this))) _syncReserve(); // params may be set before the pool lists the market
        emit ParamsSet(takerFeeBps_, makerFeeBps_, offHoursSpreadBps_, borrowBpsPerHour_, fundingK_, oiCapBps_, maxProfitBps_, liquidationFee_);
    }

    // ---------------------------------------------------------------- trader entry points

    function open(bool isLong, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps) external {
        _open(msg.sender, isLong, sizeUsd, collateral, maxSlippageBps);
    }

    function openFor(address account, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        external
    {
        _open(account, isLong, sizeUsd, collateral, maxSlippageBps);
    }

    function increase(uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps) external {
        _increase(msg.sender, sizeUsd, collateral, maxSlippageBps);
    }

    function increaseFor(address account, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps) external {
        _increase(account, sizeUsd, collateral, maxSlippageBps);
    }

    function decrease(uint256 sizeUsd) external {
        _decrease(msg.sender, sizeUsd);
    }

    function decreaseFor(address account, uint256 sizeUsd) external {
        _decrease(account, sizeUsd);
    }

    function close() external {
        _decrease(msg.sender, _positions[msg.sender].size);
    }

    function closeFor(address account) external {
        _decrease(account, _positions[account].size);
    }

    /// Anyone (except the account and its operators) closes an underwater position and earns the fee.
    function liquidate(address account) external nonReentrant {
        if (account == msg.sender || pool.isOperator(account, msg.sender)) revert NotAuthorized();
        Position storage p = _positions[account];
        if (p.size == 0) revert NoPosition();
        _accrue();
        (uint256 pr,) = _quote();
        lastPrice = pr;
        _fold(p);
        int256 eq = _equity(p, pr);
        if (eq >= int256(p.size * MAINTENANCE_BPS / BPS)) revert NotLiquidatable();

        uint256 reward = eq > 0 ? Math.min(liquidationFee, uint256(eq)) : 0;
        reward = Math.min(reward, p.collateral);
        uint256 size = p.size;
        uint256 coll = p.collateral;
        _removeFromSide(p, size, p.tokens, coll);
        delete _positions[account];
        _syncReserve();
        pool.settle(msg.sender, reward, coll);
        emit Liquidated(account, msg.sender, size, eq, reward, pr);
    }

    /// Accrue funding and borrow to now; returns the current funding rate (1e18 fraction per second, paid by
    /// the heavier side) and whether longs pay.
    function funding() external returns (uint256 ratePerSecond, bool longsPay) {
        _accrue();
        return fundingRate();
    }

    // ---------------------------------------------------------------- views

    function position(address account) external view returns (Position memory) {
        return _positions[account];
    }

    function fundingRate() public view returns (uint256 ratePerSecond, bool longsPay) {
        uint256 liquid = pool.liquidAssets();
        uint256 l = longs.size;
        uint256 s = shorts.size;
        if (l == 0 || s == 0 || liquid == 0 || l == s) return (0, l > s);
        uint256 skew = l > s ? l - s : s - l;
        return (fundingK * skew / liquid, l > s);
    }

    /// Price used now: Valuer price per token, and whether the feed is on hold.
    function price() external view returns (uint256 p, bool hold) {
        return _quote();
    }

    /// Equity (collateral + PnL - funding - borrow) at the current price, settled to now.
    function equityOf(address account) external view returns (int256) {
        Position memory p = _positions[account];
        if (p.size == 0) return 0;
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        _foldMem(p, p.isLong ? lIdx : sIdx, bIdx);
        (uint256 pr,) = _quote();
        return _equityMem(p, pr);
    }

    function isLiquidatable(address account) external view returns (bool) {
        Position memory p = _positions[account];
        if (p.size == 0) return false;
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        _foldMem(p, p.isLong ? lIdx : sIdx, bIdx);
        (uint256 pr,) = _quote();
        return _equityMem(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS);
    }

    /// Aggregate unrealized trader PnL (for LP share pricing): per side capped at the side's reserve and
    /// floored at minus the side's collateral (a loss beyond collateral is bad debt, not LP income).
    function traderPnl() external view returns (int256) {
        (uint256 pr,) = _quote();
        return _sidePnl(longs, true, pr) + _sidePnl(shorts, false, pr);
    }

    function reserve() public view returns (uint256) {
        return (longs.size + shorts.size) * maxProfitBps / BPS;
    }

    function feeBpsFor(address account) public view returns (uint256) {
        return pool.isMaker(account) ? makerFeeBps : takerFeeBps;
    }

    // ---------------------------------------------------------------- internals: actions

    function _auth(address account) internal view {
        if (msg.sender != account && !pool.isOperator(account, msg.sender)) revert NotAuthorized();
    }

    function _open(address account, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        internal
        nonReentrant
    {
        _auth(account);
        if (_positions[account].size != 0) revert HasPosition();
        if (sizeUsd == 0) revert ZeroSize();
        _accrue();
        Position storage p = _positions[account];
        p.isLong = isLong;
        p.fundingIndex = isLong ? longFundingIndex : shortFundingIndex;
        p.borrowIndex = borrowIndex;
        (uint256 pr, uint256 fee) = _add(account, p, sizeUsd, collateral, maxSlippageBps);
        emit Opened(account, msg.sender, isLong, sizeUsd, collateral, pr, fee);
    }

    function _increase(address account, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        internal
        nonReentrant
    {
        _auth(account);
        Position storage p = _positions[account];
        if (p.size == 0) revert NoPosition();
        _accrue();
        _fold(p);
        (uint256 pr, uint256 fee) = _add(account, p, sizeUsd, collateral, maxSlippageBps);
        emit Increased(account, msg.sender, sizeUsd, collateral, pr, fee);
    }

    /// Shared by open and increase. sizeUsd == 0 adds margin only, which is allowed on hold.
    function _add(address account, Position storage p, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        internal
        returns (uint256 pr, uint256 fee)
    {
        bool hold;
        (pr, hold) = _quote();
        if (sizeUsd > 0 && hold) revert Hold();
        lastPrice = pr;

        uint256 feeBps = sizeUsd > 0 ? feeBpsFor(account) : 0;
        // Oracle execution has no price impact in v1, so the only cost against the oracle is the fee.
        if (feeBps > maxSlippageBps) revert SlippageExceeded(feeBps, maxSlippageBps);
        fee = Math.mulDiv(sizeUsd, feeBps, BPS, Math.Rounding.Ceil);
        if (collateral < fee) revert CollateralTooLow();
        uint256 kept = collateral - fee;

        uint256 tokens = Math.mulDiv(sizeUsd, ONE, pr, p.isLong ? Math.Rounding.Floor : Math.Rounding.Ceil);
        p.size += sizeUsd;
        p.tokens += tokens;
        p.collateral += kept;
        Side storage side = p.isLong ? longs : shorts;
        side.size += sizeUsd;
        side.tokens += tokens;
        side.collateral += kept;

        if (p.collateral == 0 || p.size > p.collateral * MAX_LEVERAGE) revert Leverage();
        if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();

        pool.lockCollateral(account, collateral, kept);
        if (sizeUsd > 0) {
            if (side.size > pool.liquidAssets() * oiCapBps / BPS) revert OiCap();
            _syncReserve();
        }
    }

    struct Exit {
        uint256 exec;
        uint256 tokens;
        uint256 coll;
        int256 funding;
        uint256 borrow;
        int256 pnl;
        uint256 fee;
        uint256 payout;
        uint256 collateralOut;
    }

    function _decrease(address account, uint256 sizeUsd) internal nonReentrant {
        _auth(account);
        Position storage p = _positions[account];
        if (p.size == 0) revert NoPosition();
        if (sizeUsd == 0) revert ZeroSize();
        if (sizeUsd > p.size) sizeUsd = p.size;
        _accrue();
        _fold(p);

        (uint256 pr, bool hold) = _quote();
        lastPrice = pr;
        Exit memory x;
        x.exec = pr;
        if (hold) {
            // Worse for the trader: a long sells lower, a short buys back higher.
            x.exec = p.isLong
                ? pr * (BPS - offHoursSpreadBps) / BPS
                : Math.mulDiv(pr, BPS + offHoursSpreadBps, BPS, Math.Rounding.Ceil);
        }

        bool full = sizeUsd == p.size;
        if (full) {
            (x.tokens, x.coll, x.funding, x.borrow) = (p.tokens, p.collateral, p.accruedFunding, p.accruedBorrow);
        } else {
            x.tokens = Math.mulDiv(p.tokens, sizeUsd, p.size, p.isLong ? Math.Rounding.Floor : Math.Rounding.Ceil);
            x.coll = p.collateral * sizeUsd / p.size;
            x.funding = _mulDivSigned(p.accruedFunding, sizeUsd, p.size);
            x.borrow = Math.mulDiv(p.accruedBorrow, sizeUsd, p.size, Math.Rounding.Ceil);
        }
        x.pnl = _pnl(p.isLong, sizeUsd, x.tokens, x.exec);
        x.fee = Math.mulDiv(sizeUsd, feeBpsFor(account), BPS, Math.Rounding.Ceil);
        int256 out = x.coll.toInt256() + _cappedNet(x, sizeUsd) - x.fee.toInt256();

        _removeFromSide(p, sizeUsd, x.tokens, x.coll);
        p.size -= sizeUsd;
        p.tokens -= x.tokens;
        p.collateral -= x.coll;
        p.accruedFunding -= x.funding;
        p.accruedBorrow -= x.borrow;

        x.collateralOut = x.coll;
        if (out >= 0) {
            x.payout = uint256(out);
        } else if (!full) {
            // A partial decrease whose loss exceeds the released collateral takes the rest from the margin.
            uint256 shortfall = uint256(-out);
            if (shortfall > p.collateral) revert Liquidatable();
            p.collateral -= shortfall;
            (p.isLong ? longs : shorts).collateral -= shortfall;
            x.collateralOut += shortfall;
        }

        if (full) {
            delete _positions[account];
        } else {
            if (p.size > p.collateral * MAX_LEVERAGE) revert Leverage();
            if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();
        }
        _syncReserve();
        pool.settle(account, x.payout, x.collateralOut);
        emit Decreased(account, msg.sender, sizeUsd, x.pnl, x.funding, x.borrow, x.fee, x.payout, x.exec);
    }

    /// Net profit of a realization (PnL - funding - borrow), capped at the reserve held for that size.
    function _cappedNet(Exit memory x, uint256 sizeUsd) internal view returns (int256 net) {
        net = x.pnl - x.funding - x.borrow.toInt256();
        int256 cap = (sizeUsd * maxProfitBps / BPS).toInt256();
        if (net > cap) net = cap;
    }

    // ---------------------------------------------------------------- internals: accounting

    function _removeFromSide(Position storage p, uint256 size, uint256 tokens, uint256 coll) internal {
        Side storage side = p.isLong ? longs : shorts;
        side.size -= size;
        side.tokens -= tokens;
        side.collateral -= coll;
    }

    function _syncReserve() internal {
        pool.setReserve(reserve());
    }

    function _accrue() internal {
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        if (block.timestamp == lastAccrual) return;
        // Totals for the conservation check: heavy side pays size x delta, light side gets size x delta.
        if (lIdx > longFundingIndex) {
            fundingPaidTotal += longs.size * uint256(lIdx - longFundingIndex);
            fundingReceivedTotal += shorts.size * uint256(shortFundingIndex - sIdx);
        } else if (sIdx > shortFundingIndex) {
            fundingPaidTotal += shorts.size * uint256(sIdx - shortFundingIndex);
            fundingReceivedTotal += longs.size * uint256(longFundingIndex - lIdx);
        }
        (longFundingIndex, shortFundingIndex, borrowIndex) = (lIdx, sIdx, bIdx);
        lastAccrual = block.timestamp;
        emit FundingAccrued(lIdx, sIdx, bIdx);
    }

    function _indicesNow() internal view returns (int256 lIdx, int256 sIdx, uint256 bIdx) {
        (lIdx, sIdx, bIdx) = (longFundingIndex, shortFundingIndex, borrowIndex);
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return (lIdx, sIdx, bIdx);
        bIdx += borrowBpsPerHour * WAD * dt / (3600 * BPS);
        (uint256 rate, bool longsPay) = fundingRate();
        if (rate == 0) return (lIdx, sIdx, bIdx);
        uint256 f = rate * dt; // fraction of size (1e18) the heavy side pays
        (uint256 heavy, uint256 light) = longsPay ? (longs.size, shorts.size) : (shorts.size, longs.size);
        uint256 lightDelta = heavy * f / light; // floor: receivers never get more than payers pay
        if (longsPay) {
            lIdx += f.toInt256();
            sIdx -= lightDelta.toInt256();
        } else {
            sIdx += f.toInt256();
            lIdx -= lightDelta.toInt256();
        }
    }

    function _fold(Position storage p) internal {
        int256 idx = p.isLong ? longFundingIndex : shortFundingIndex;
        p.accruedFunding += _fundingOwed(p.size, idx - p.fundingIndex);
        p.accruedBorrow += Math.mulDiv(p.size, borrowIndex - p.borrowIndex, WAD, Math.Rounding.Ceil);
        p.fundingIndex = idx;
        p.borrowIndex = borrowIndex;
    }

    function _foldMem(Position memory p, int256 idx, uint256 bIdx) internal pure {
        p.accruedFunding += _fundingOwed(p.size, idx - p.fundingIndex);
        p.accruedBorrow += Math.mulDiv(p.size, bIdx - p.borrowIndex, WAD, Math.Rounding.Ceil);
        p.fundingIndex = idx;
        p.borrowIndex = bIdx;
    }

    /// Owed funding for `size` over an index delta: paying rounds up, receiving rounds down.
    function _fundingOwed(uint256 size, int256 delta) internal pure returns (int256) {
        if (delta >= 0) return Math.mulDiv(size, uint256(delta), WAD, Math.Rounding.Ceil).toInt256();
        return -(size * uint256(-delta) / WAD).toInt256();
    }

    /// PnL of `size` notional held as `tokens` at `pr`: value rounds against the trader.
    function _pnl(bool isLong, uint256 size, uint256 tokens, uint256 pr) internal view returns (int256) {
        if (isLong) return Math.mulDiv(tokens, pr, ONE).toInt256() - size.toInt256();
        return size.toInt256() - Math.mulDiv(tokens, pr, ONE, Math.Rounding.Ceil).toInt256();
    }

    function _equity(Position storage p, uint256 pr) internal view returns (int256) {
        return p.collateral.toInt256() + _pnl(p.isLong, p.size, p.tokens, pr) - p.accruedFunding
            - p.accruedBorrow.toInt256();
    }

    function _equityMem(Position memory p, uint256 pr) internal view returns (int256) {
        return p.collateral.toInt256() + _pnl(p.isLong, p.size, p.tokens, pr) - p.accruedFunding
            - p.accruedBorrow.toInt256();
    }

    function _sidePnl(Side memory s, bool isLong, uint256 pr) internal view returns (int256 v) {
        if (s.size == 0) return 0;
        v = _pnl(isLong, s.size, s.tokens, pr);
        int256 cap = (s.size * maxProfitBps / BPS).toInt256();
        if (v > cap) v = cap;
        if (v < -s.collateral.toInt256()) v = -s.collateral.toInt256();
    }

    /// Valuer price, or the last stored price on hold if the Valuer reverts (e.g. token delisted).
    function _quote() internal view returns (uint256 pr, bool hold) {
        try valuer.quote(underlying) returns (Valuer.Quote memory q) {
            return (q.priceUsdPerToken, q.hold);
        } catch {
            return (lastPrice, true);
        }
    }

    function _mulDivSigned(int256 x, uint256 n, uint256 d) internal pure returns (int256) {
        // Against the trader: an amount owed realizes rounded up, an amount received rounded down.
        if (x >= 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();
        return -(uint256(-x) * n / d).toInt256();
    }
}
