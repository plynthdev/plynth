// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Valuer} from "../core/Valuer.sol";
import {StockTokenRegistry} from "../core/StockTokenRegistry.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";
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
/// The hold spread is the largest plausible off-hours gap (default 10%, floor 5%, max 30%), not a small fee:
/// the real price keeps moving off-chain while the feed is stale, so a cheap exit at the stale price would be
/// a free option against the LPs (close the leg that lost overnight, keep the one that won). A trader who does
/// not want to pay it waits for the next fresh price. Liquidations still run at the stale price (a third
/// party, not the trader, picks that moment), and open/increase in the first `maxStaleness` after the last
/// update still use the frozen price: both are documented limits.
///
/// A hold that outlasts `HELD_GRACE` (a halted feed, a delisted token) must not freeze the pool: from then on the
/// market no longer blocks LP exits (its open interest is valued at the reserve, the most traders can be paid, so
/// an exit is never at a price the remaining LPs pay for), and anyone can `settleHeld` each position at the last
/// price (no hold spread, normal fee and profit cap) so open interest reaches 0 and the pool can drop the market.
///
/// Oracle front-running (an order fills at the oracle price in the transaction that sends it, and the real price
/// runs up to the feeds' 0.5% deviation threshold ahead of it): open and increase pay `openSpreadBps` on size on top
/// of the fee (to the LPs, like a fill that much worse), and a decrease or close within `minHoldSeconds` of the position's last open or increase realizes losses
/// normally but no net profit. So "open just before the update, close right after" earns nothing, and waiting out
/// the hold costs the spread plus two fees, which together exceed the deviation threshold. Fills stay synchronous
/// (the treasury venue adapter needs that) and closing is never blocked; liquidations are unaffected.
///
/// Bad debt (a gap past zero equity): liquidation always pays at least `minLiquidationReward` (from the pool when
/// the position has nothing left), so an underwater position is worth closing for anyone and its owner keeps no
/// free option on a recovery. That top-up is never more than the position's own collateral (which the LPs keep), so
/// the LPs never pay a liquidator more than the liquidated position brought in (review v2 M-3). LP equity values
/// every position on its own, floored at minus its collateral and capped at its maximum payout, so one trader's bad
/// debt is never netted against another's gain. That needs the open positions enumerable: at most
/// `MAX_OPEN_POSITIONS` per market, and every position keeps at least `minCollateral` of collateral and of size
/// after every open, increase and partial decrease (a smaller remainder must close in full), so a slot always locks
/// real capital that pays borrow on real size (review v2 M-2).
///
/// Slots (review v3 R3-PERP-1, v4 R4-PERP-1): the bound is held by whoever fills it, not charged to newcomers. When
/// the market is full, an open of at least DISPLACE_FACTOR times the smallest position past its minimum hold
/// displaces it: that position is closed for its owner exactly as its own full close at the oracle price would be
/// (fee and profit cap; it is past the hold, so its profit is paid), and the newcomer takes its slot. A position
/// inside its hold is never displaced, so nobody can confiscate a young position's profit, and displacing one's own
/// position gains nothing over closing it. Invariant (PerpSlotInvariant): the open-position count never exceeds
/// MAX_OPEN_POSITIONS, an open of DISPLACE_FACTOR times the smallest mature position is always admitted, and a
/// displaced position receives what its voluntary close would have paid. So keeping opens of size X out requires
/// every slot either to hold at least X / DISPLACE_FACTOR (50·X of open interest paying borrow, 3.6·X USDG a month at
/// 1 bps/h: over 50k a month to keep out opens under about 14k, and room for it under the per-side OI cap) or to be
/// kept inside its hold, which only an increase of at least minCollateral every minHoldSeconds does (fee and spread
/// in, fee out: about 89k USDG a month for 100 slots at mainnet values). Nothing scales anyone else's floor. The owner can
/// `retire` a market: opens stop at
/// once and, after `pool.TIMELOCK()` in public, anyone settles the remaining positions at a fresh oracle price, so a
/// market can always be emptied and removed from the pool whoever holds its slots.
///
/// Funding: rate/s = fundingK x (longOI - shortOI) / poolLiquid, heavier side pays, lighter side receives
/// pro rata (only while both sides are open). The pool accrues every market before its liquidity changes, so
/// the rate applied to an interval always used that interval's liquidity (USDG donated straight to the pool
/// is the one change it cannot see, and it only lowers the rate at the donor's cost). Borrow fee `borrowBpsPerHour` on size goes to LPs.
/// A realization's net profit (PnL - funding - borrow) is capped at size x maxProfitBps, which is the
/// reserve the pool holds for it.
contract PerpMarket is Ownable2Step, ReentrancyGuard {
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.AddressSet;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 50;
    uint256 public constant MAINTENANCE_BPS = 100;
    uint256 public constant MIN_HOLD_SPREAD_BPS = 500;
    uint256 public constant MAX_HOLD_SPREAD_BPS = 3_000;
    uint256 public constant MIN_OPEN_SPREAD_BPS = 10;
    uint256 public constant MAX_OPEN_SPREAD_BPS = 300;
    uint256 public constant MIN_HOLD_FLOOR = 5 minutes;
    uint256 public constant MAX_MIN_HOLD = 1 days;
    /// Chainlink's deviation threshold on the Stock Token feeds (0.5%). The open spread plus the cheaper of the taker
    /// and maker fees in and out must stay above it, or "open before the update, close after" pays (audit M-3,
    /// review v2 L-2; makers are treasury desks, which count as adversaries too).
    uint256 public constant FEED_DEVIATION_BPS = 50;
    /// Highest open-interest cap per side, of pool liquidity (audit PERP-4: never all of the pool).
    uint256 public constant MAX_OI_CAP_BPS = 5_000;
    /// Open positions per market (both sides). Every LP share-price read (deposit, redeem, the treasury's NAV)
    /// values each one: ~10k gas each cold (set slot + size, collateral, tokens), ~1.1M for a full market, and
    /// the pool's four mainnet markets stay under ~5M per read (test_M4_totalAssetsGasWithAFullMarket). With
    /// displacement (DISPLACE_FACTOR), a full market keeps an open out only if it is under twice the smallest
    /// position, so holding the slots against size X costs 50·X of open interest; `retire` still empties a market.
    uint256 public constant MAX_OPEN_POSITIONS = 100;
    /// In a full market, an open at least this many times the smallest open position's size displaces it (see the
    /// contract notes).
    uint256 public constant DISPLACE_FACTOR = 2;
    /// settleHeld uses a delisted token's own feed only within this distance of the last recorded price (30%, the
    /// largest hold spread): a bigger jump on a feed that was just delisted is more likely a fault than a move.
    uint256 public constant MAX_HELD_FEED_DEVIATION_BPS = 3_000;
    /// How long a market may sit on hold (measured from its last fresh price) before it stops blocking the pool
    /// and its positions become settleable at the last price: longer than a weekend plus a market holiday, and
    /// plus Chainlink's 24 h heartbeat on these feeds, so a normal off-hours hold never triggers it.
    uint256 public constant HELD_GRACE = 5 days;
    /// A matured proposal must be applied within this long after its eta.
    uint256 public constant PROPOSAL_EXPIRY = 14 days;
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
        uint64 openedAt; // last open or increase (adding margin only does not count)
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
    /// One whole unit of the pool asset (1 USDG).
    uint256 public immutable UNIT;

    uint256 public takerFeeBps = 10;
    /// 6 bps: with the 40 bps open spread a maker's round trip is 52 bps, above the feeds' 50 bps deviation (makers
    /// are treasury desks, which count as adversaries too: review v2 L-2 follow-up).
    uint256 public makerFeeBps = 6;
    uint256 public offHoursSpreadBps = 1_000;
    uint256 public borrowBpsPerHour = 1;
    uint256 public fundingK = 2.78e11; // ~0.1%/h when skew equals the pool
    uint256 public oiCapBps = 2_000; // per side, of pool liquid assets
    uint256 public maxProfitBps = 10_000;
    uint256 public liquidationFee = 5e6;
    /// 40 bps: with the 10 bps taker fee in and out, a round trip costs 60 bps, above the feeds' 50 bps deviation.
    uint256 public openSpreadBps = 40;
    uint256 public minHoldSeconds = 30 minutes;
    /// Paid to a liquidator even when the position's equity is below it (the pool pays the rest). 1 USDG.
    uint256 public minLiquidationReward;
    /// Least collateral posted to open, and least collateral (after fees) and size a position keeps after every
    /// open, increase and partial decrease. 100 USDG.
    uint256 public minCollateral;

    Side public longs;
    Side public shorts;
    int256 public longFundingIndex;
    int256 public shortFundingIndex;
    uint256 public borrowIndex;
    uint256 public lastAccrual;
    uint256 public lastPrice;
    /// Feed time (Valuer `updatedAt`) of `lastPrice`: how long a market has been on hold when the Valuer reverts.
    uint256 public lastPriceAt;
    /// When the Valuer started reverting (a delisted token: its delisting time; otherwise the first state-changing
    /// call that saw it), 0 while it answers. A delisted market's hold is measured from the later of `lastPriceAt`
    /// and this, so a market nobody touched for days is not settleable the moment it is delisted (review v2 L-1).
    uint256 public unpricedSince;
    /// When settleRetired opens; opens stopped when it was set (0 = not retired). See `retire`.
    uint256 public retireAt;
    /// Index-level funding totals (asset units x 1e18): conservation check, paid >= received, diff is dust.
    uint256 public fundingPaidTotal;
    uint256 public fundingReceivedTotal;

    mapping(address account => Position) internal _positions;
    /// Timelocked changes: proposal id (paramsId / guardsId) => time it may be applied.
    mapping(bytes32 id => uint256) public etaOf;
    /// Bumped on every ownership change and part of every proposal id: a proposal made under one owner (the
    /// deployer) is void for the next (review v2 L-6, applied to the perps proposals).
    uint256 public proposalNonce;
    EnumerableSet.AddressSet internal _longAccounts;
    EnumerableSet.AddressSet internal _shortAccounts;

    event Opened(address indexed account, address indexed by, bool isLong, uint256 sizeUsd, uint256 collateral, uint256 price, uint256 fee);
    event Increased(address indexed account, address indexed by, uint256 sizeUsd, uint256 collateral, uint256 price, uint256 fee);
    event Decreased(address indexed account, address indexed by, uint256 sizeUsd, int256 pnl, int256 funding, uint256 borrow, uint256 fee, uint256 payout, uint256 price);
    event Displaced(address indexed account, address indexed by, uint256 size);
    event Liquidated(address indexed account, address indexed by, uint256 size, int256 equity, uint256 reward, uint256 price);
    event FundingAccrued(int256 longIndex, int256 shortIndex, uint256 borrowIndex);
    event ChangeProposed(bytes32 indexed id, uint256 eta);
    event ChangeCancelled(bytes32 indexed id);
    event GuardsSet(uint256 openSpreadBps, uint256 minHoldSeconds, uint256 minLiquidationReward, uint256 minCollateral);
    event HeldSettled(address indexed account, address indexed by, uint256 heldFor);
    event Retiring(uint256 settleFrom);
    event RetiredSettled(address indexed account, address indexed by);
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
    error NotHeldLongEnough(uint256 heldFor);
    error TooManyPositions();
    error TimelockActive(bytes32 id, uint256 eta);
    error NotProposed(bytes32 id);
    error ProposalExpired(bytes32 id, uint256 eta);
    error SizeTooSmall();
    error RoundTripTooCheap(uint256 openSpreadBps, uint256 feeBps);
    error Retired();
    error NotRetired(uint256 settleFrom);

    constructor(PerpPool pool_, Valuer valuer_, address underlying_, address owner_) Ownable(owner_) {
        pool = pool_;
        valuer = valuer_;
        underlying = underlying_;
        uint8 assetDec = IERC20Metadata(pool_.asset()).decimals();
        ONE = 10 ** (18 - assetDec) * 10 ** IERC20Metadata(underlying_).decimals();
        UNIT = 10 ** assetDec;
        minLiquidationReward = UNIT;
        minCollateral = 100 * UNIT;
        lastAccrual = block.timestamp;
        _quoteAndRecord();
    }

    // ---------------------------------------------------------------- admin

    struct Params {
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint256 offHoursSpreadBps;
        uint256 borrowBpsPerHour;
        uint256 fundingK;
        uint256 oiCapBps;
        uint256 maxProfitBps;
        uint256 liquidationFee;
    }

    struct Guards {
        uint256 openSpreadBps;
        uint256 minHoldSeconds;
        uint256 minLiquidationReward;
        uint256 minCollateral;
    }

    /// Risk params. Once the pool has LP shares or this market has open interest, a change applies only
    /// `pool.TIMELOCK()` after `proposeParams` with the same values (48 h on mainnet), so LPs and traders can
    /// leave first. Instant: before any LP or position exists (the deploy script configures everything in one
    /// run), and a change that only lowers oiCapBps (it only refuses new opens).
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
        Params memory p = Params(
            takerFeeBps_, makerFeeBps_, offHoursSpreadBps_, borrowBpsPerHour_, fundingK_, oiCapBps_, maxProfitBps_, liquidationFee_
        );
        _checkParams(p);
        _checkRoundTrip(openSpreadBps, p.takerFeeBps, p.makerFeeBps);
        if (!_instant() && !_paramsReduceRisk(p)) _consume(paramsId(p));
        _applyParams(p);
    }

    function proposeParams(
        uint256 takerFeeBps_,
        uint256 makerFeeBps_,
        uint256 offHoursSpreadBps_,
        uint256 borrowBpsPerHour_,
        uint256 fundingK_,
        uint256 oiCapBps_,
        uint256 maxProfitBps_,
        uint256 liquidationFee_
    ) external onlyOwner {
        Params memory p = Params(
            takerFeeBps_, makerFeeBps_, offHoursSpreadBps_, borrowBpsPerHour_, fundingK_, oiCapBps_, maxProfitBps_, liquidationFee_
        );
        _checkParams(p);
        _checkRoundTrip(openSpreadBps, p.takerFeeBps, p.makerFeeBps);
        _propose(paramsId(p));
    }

    /// Guards: the open spread (10..300 bps), the minimum hold for a profit (5 min..1 day), the minimum
    /// liquidation reward (1 unit..liquidationFee) and the minimum collateral of a new position (1..10,000 units).
    /// Timelocked like setParams; instant before any LP or position, and when it only raises the open spread (it only
    /// makes new opens dearer, and maxSlippageBps protects a pending open). A minimum-collateral change always waits:
    /// a raise also stops existing positions from trimming (review v3 R3-PERP-3).
    function setGuards(
        uint256 openSpreadBps_,
        uint256 minHoldSeconds_,
        uint256 minLiquidationReward_,
        uint256 minCollateral_
    ) external onlyOwner {
        Guards memory g = Guards(openSpreadBps_, minHoldSeconds_, minLiquidationReward_, minCollateral_);
        _checkGuards(g);
        _checkRoundTrip(g.openSpreadBps, takerFeeBps, makerFeeBps);
        if (!_instant() && !_guardsReduceRisk(g)) _consume(guardsId(g));
        _applyGuards(g);
    }

    function proposeGuards(
        uint256 openSpreadBps_,
        uint256 minHoldSeconds_,
        uint256 minLiquidationReward_,
        uint256 minCollateral_
    ) external onlyOwner {
        Guards memory g = Guards(openSpreadBps_, minHoldSeconds_, minLiquidationReward_, minCollateral_);
        _checkGuards(g);
        _checkRoundTrip(g.openSpreadBps, takerFeeBps, makerFeeBps);
        _propose(guardsId(g));
    }

    function cancel(bytes32 id) external onlyOwner {
        if (etaOf[id] == 0) revert NotProposed(id);
        delete etaOf[id];
        emit ChangeCancelled(id);
    }

    /// Wind the market down: opens and increases stop at once (risk-reducing), and from `pool.TIMELOCK()` later anyone
    /// may `settleRetired` each remaining position at a fresh oracle price (normal fee and profit cap, no hold
    /// spread), so open interest can always reach 0 and the pool can drop the market (review v2 M-2). One-way.
    function retire() external onlyOwner {
        if (retireAt != 0) revert Retired();
        uint256 at = block.timestamp + pool.TIMELOCK();
        retireAt = at;
        emit Retiring(at);
    }

    function paramsId(Params memory p) public view returns (bytes32) {
        return keccak256(abi.encode(proposalNonce, "params", p));
    }

    function guardsId(Guards memory g) public view returns (bytes32) {
        return keccak256(abi.encode(proposalNonce, "guards", g));
    }

    function _checkParams(Params memory p) internal view {
        if (
            p.takerFeeBps > 100 || p.makerFeeBps > p.takerFeeBps || p.offHoursSpreadBps < MIN_HOLD_SPREAD_BPS
                || p.offHoursSpreadBps > MAX_HOLD_SPREAD_BPS || p.borrowBpsPerHour > 100 || p.fundingK > 1e14
                || p.oiCapBps > MAX_OI_CAP_BPS || p.maxProfitBps < MAINTENANCE_BPS || p.maxProfitBps > 10 * BPS
                || p.liquidationFee < minLiquidationReward
        ) revert BadParams();
    }

    /// Open spread plus the cheaper of the two fees in and out above the feeds' deviation threshold: the round trip
    /// the cheapest front-runner pays, a maker (treasury desk) included (checked against the value the other setter
    /// keeps).
    function _checkRoundTrip(uint256 spreadBps, uint256 takerBps, uint256 makerBps) internal pure {
        uint256 fee = takerBps < makerBps ? takerBps : makerBps;
        if (spreadBps + 2 * fee <= FEED_DEVIATION_BPS) revert RoundTripTooCheap(spreadBps, fee);
    }

    function _applyParams(Params memory p) internal {
        _accrue();
        (takerFeeBps, makerFeeBps, offHoursSpreadBps, borrowBpsPerHour) =
            (p.takerFeeBps, p.makerFeeBps, p.offHoursSpreadBps, p.borrowBpsPerHour);
        (fundingK, oiCapBps, maxProfitBps, liquidationFee) = (p.fundingK, p.oiCapBps, p.maxProfitBps, p.liquidationFee);
        if (pool.isMarket(address(this))) _syncReserve(); // params may be set before the pool lists the market
        emit ParamsSet(
            p.takerFeeBps, p.makerFeeBps, p.offHoursSpreadBps, p.borrowBpsPerHour, p.fundingK, p.oiCapBps, p.maxProfitBps, p.liquidationFee
        );
    }

    function _checkGuards(Guards memory g) internal view {
        if (
            g.openSpreadBps < MIN_OPEN_SPREAD_BPS || g.openSpreadBps > MAX_OPEN_SPREAD_BPS
                || g.minHoldSeconds < MIN_HOLD_FLOOR || g.minHoldSeconds > MAX_MIN_HOLD || g.minLiquidationReward < UNIT
                || g.minLiquidationReward > liquidationFee || g.minCollateral < UNIT || g.minCollateral > 10_000 * UNIT
        ) revert BadParams();
    }

    function _applyGuards(Guards memory g) internal {
        (openSpreadBps, minHoldSeconds) = (g.openSpreadBps, g.minHoldSeconds);
        (minLiquidationReward, minCollateral) = (g.minLiquidationReward, g.minCollateral);
        emit GuardsSet(g.openSpreadBps, g.minHoldSeconds, g.minLiquidationReward, g.minCollateral);
    }

    /// Nobody can be hurt yet: no LP shares in the pool and no open interest here.
    function _instant() internal view returns (bool) {
        return openInterest() == 0 && pool.totalSupply() == 0;
    }

    function _paramsReduceRisk(Params memory p) internal view returns (bool) {
        return p.oiCapBps <= oiCapBps && p.takerFeeBps == takerFeeBps && p.makerFeeBps == makerFeeBps
            && p.offHoursSpreadBps == offHoursSpreadBps && p.borrowBpsPerHour == borrowBpsPerHour && p.fundingK == fundingK
            && p.maxProfitBps == maxProfitBps && p.liquidationFee == liquidationFee;
    }

    function _guardsReduceRisk(Guards memory g) internal view returns (bool) {
        return g.openSpreadBps >= openSpreadBps && g.minCollateral == minCollateral && g.minHoldSeconds == minHoldSeconds
            && g.minLiquidationReward == minLiquidationReward;
    }

    function _propose(bytes32 id) internal {
        uint256 eta = block.timestamp + pool.TIMELOCK();
        etaOf[id] = eta;
        emit ChangeProposed(id, eta);
    }

    /// A matured proposal is used up by the change it announced. It is good for PROPOSAL_EXPIRY after its eta; a
    /// change announced long ago needs a fresh proposal (review v2 L-6).
    function _consume(bytes32 id) internal {
        uint256 eta = etaOf[id];
        if (eta == 0 || block.timestamp < eta) revert TimelockActive(id, eta);
        if (block.timestamp > eta + PROPOSAL_EXPIRY) revert ProposalExpired(id, eta);
        delete etaOf[id];
    }

    /// Every ownership change (the constructor's too) voids the proposals made so far.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        ++proposalNonce;
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
        _decrease(msg.sender, sizeUsd, false, 0);
    }

    function decreaseFor(address account, uint256 sizeUsd) external {
        _decrease(account, sizeUsd, false, 0);
    }

    function close() external {
        _decrease(msg.sender, _positions[msg.sender].size, false, 0);
    }

    function closeFor(address account) external {
        _decrease(account, _positions[account].size, false, 0);
    }

    /// Anyone (except the account and its operators) closes an underwater position and earns the fee.
    function liquidate(address account) external nonReentrant {
        if (account == msg.sender || pool.isOperator(account, msg.sender)) revert NotAuthorized();
        Position storage p = _positions[account];
        if (p.size == 0) revert NoPosition();
        _accrue();
        (uint256 pr,,) = _quoteAndRecord();
        _fold(p);
        int256 eq = _equity(p, pr);
        if (eq >= int256(p.size * MAINTENANCE_BPS / BPS)) revert NotLiquidatable();

        // The fee out of what is left, and never less than the minimum reward: below it (bad debt) the pool pays
        // the difference, so closing an underwater position is always worth a keeper's transaction. The top-up is
        // capped at the position's own collateral (the LPs keep it), so a dust-collateral position can never be
        // liquidated for more than it brought in (review v2 M-3).
        uint256 size = p.size;
        uint256 coll = p.collateral;
        uint256 reward = eq > 0 ? Math.min(liquidationFee, uint256(eq)) : 0;
        reward = Math.max(reward, Math.min(minLiquidationReward, coll));
        _removeFromSide(p, size, p.tokens, coll);
        _forget(account, p.isLong);
        delete _positions[account];
        _syncReserve();
        pool.settle(msg.sender, reward, coll);
        emit Liquidated(account, msg.sender, size, eq, reward, pr);
    }

    /// Close `account`'s whole position at the last price once the market has been on hold longer than
    /// `HELD_GRACE` (feed halted, token delisted). Anyone may call it: without it one position on a dead market
    /// would keep open interest (and so the pool's hold) alive for as long as its owner likes. No hold spread
    /// (nobody chooses this moment: it opens to everyone at once); fee and profit cap as a normal close.
    function settleHeld(address account) external {
        uint256 held = heldFor();
        if (held <= HELD_GRACE) revert NotHeldLongEnough(held);
        _decrease(account, _positions[account].size, true, _heldSettlePrice());
        emit HeldSettled(account, msg.sender, held);
    }

    /// Close `account`'s whole position at a fresh oracle price once the market is retired and its notice has passed
    /// (see `retire`). Anyone may call it. Waits while the price is on hold (settleHeld covers a long hold).
    function settleRetired(address account) external {
        uint256 at = retireAt;
        if (at == 0 || block.timestamp < at) revert NotRetired(at);
        (, bool hold,) = _quote();
        if (hold) revert Hold();
        _decrease(account, _positions[account].size, true, 0);
        emit RetiredSettled(account, msg.sender);
    }

    /// Accrue funding and borrow to now. The pool calls this on every market before its liquidity changes.
    function accrue() external {
        _accrue();
    }

    /// Accrue and record the current price and its feed time (if the Valuer answers), so a later delisting
    /// measures its hold from a recent price. Anyone may call it.
    function poke() external nonReentrant {
        _accrue();
        _quoteAndRecord();
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
        (p, hold,) = _quote();
    }

    /// Seconds the market has been on hold, counted from its last fresh price (0 when not on hold).
    function heldFor() public view returns (uint256) {
        (, bool hold, uint256 at) = _quote();
        if (!hold || block.timestamp <= at) return 0;
        return block.timestamp - at;
    }

    function openInterest() public view returns (uint256) {
        return longs.size + shorts.size;
    }

    /// Equity (collateral + PnL - funding - borrow) at the current price, settled to now.
    function equityOf(address account) external view returns (int256) {
        Position memory p = _positions[account];
        if (p.size == 0) return 0;
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        _foldMem(p, p.isLong ? lIdx : sIdx, bIdx);
        (uint256 pr,,) = _quote();
        return _equityMem(p, pr);
    }

    /// What a full close would pay now at the oracle price (ignoring the hold spread): collateral plus the
    /// net profit capped at size x maxProfitBps (at 0 inside the minimum hold), minus the exit fee, floored at 0.
    /// Venues value positions with this, so a valuation never counts profit the market will not pay.
    function exitValueOf(address account) external view returns (uint256) {
        Position memory p = _positions[account];
        if (p.size == 0) return 0;
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        _foldMem(p, p.isLong ? lIdx : sIdx, bIdx);
        (uint256 pr,,) = _quote();
        Exit memory x;
        x.pnl = _pnl(p.isLong, p.size, p.tokens, pr);
        x.funding = p.accruedFunding;
        x.borrow = p.accruedBorrow;
        int256 out = p.collateral.toInt256() + _cappedNet(x, p.size, _youngMem(p))
            - Math.mulDiv(p.size, feeBpsFor(account), BPS, Math.Rounding.Ceil).toInt256();
        return out > 0 ? uint256(out) : 0;
    }

    function isLiquidatable(address account) external view returns (bool) {
        Position memory p = _positions[account];
        if (p.size == 0) return false;
        (int256 lIdx, int256 sIdx, uint256 bIdx) = _indicesNow();
        _foldMem(p, p.isLong ? lIdx : sIdx, bIdx);
        (uint256 pr,,) = _quote();
        return _equityMem(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS);
    }

    /// Aggregate unrealized trader PnL (for LP share pricing), position by position: each capped at its maximum
    /// payout (size x maxProfitBps) and floored at minus its collateral (a loss beyond collateral is bad debt,
    /// not LP income, and is never netted against another trader's gain). Funding and borrow are left out as
    /// before (borrow is LP income not yet counted; funding moves between traders). After HELD_GRACE on hold
    /// the last price says nothing about the real one, so every position counts at its maximum payout (the
    /// reserve): an LP leaving then never leaves a loss behind for the others.
    function traderPnl() external view returns (int256 v) {
        (uint256 pr, bool hold, uint256 at) = _quote();
        if (hold && _pastGrace(at)) return reserve().toInt256();
        v = _setPnl(_longAccounts, true, pr) + _setPnl(_shortAccounts, false, pr);
    }

    /// Every account with an open position (longs first).
    function openPositions() external view returns (address[] memory out) {
        address[] memory l = _longAccounts.values();
        address[] memory s_ = _shortAccounts.values();
        out = new address[](l.length + s_.length);
        for (uint256 i; i < l.length; i++) {
            out[i] = l[i];
        }
        for (uint256 i; i < s_.length; i++) {
            out[l.length + i] = s_[i];
        }
    }

    /// The smallest open position past its minimum hold (by size) and its size; (0, 0) if there is none. A full market
    /// lets an open of DISPLACE_FACTOR times this size displace it. A position inside its hold is never displaced: its
    /// owner keeps the right to the profit a voluntary close after the hold would pay.
    function smallestMaturePosition() public view returns (address account, uint256 size) {
        (account, size) = _smallestMatureIn(_longAccounts, address(0), type(uint256).max);
        (account, size) = _smallestMatureIn(_shortAccounts, account, size);
        if (account == address(0)) size = 0;
    }

    function _smallestMatureIn(EnumerableSet.AddressSet storage set, address best, uint256 bestSize)
        internal
        view
        returns (address, uint256)
    {
        uint256 n = set.length();
        uint256 hold = minHoldSeconds;
        for (uint256 i; i < n; i++) {
            address a = set.at(i);
            Position storage p = _positions[a];
            uint256 s = p.size;
            if (s < bestSize && block.timestamp >= uint256(p.openedAt) + hold) (best, bestSize) = (a, s);
        }
        return (best, bestSize);
    }

    function openPositionCount() public view returns (uint256) {
        return _longAccounts.length() + _shortAccounts.length();
    }

    /// True while open interest is valued at a stale price, for at most HELD_GRACE (the pool then pauses LP
    /// entries and exits). Past the grace the valuation is the conservative reserve and exits reopen.
    function staleWithOpenInterest() external view returns (bool) {
        if (openInterest() == 0) return false;
        (, bool hold, uint256 at) = _quote();
        return hold && !_pastGrace(at);
    }

    /// True while open interest is on hold at all. The pool keeps deposits closed for the whole hold: past the
    /// grace the share price is the exit-side (conservative) one, and a deposit at it would take value from
    /// the LPs already in once the market reprices or settles.
    function onHoldWithOpenInterest() external view returns (bool) {
        if (openInterest() == 0) return false;
        (, bool hold,) = _quote();
        return hold;
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
        if (collateral < minCollateral) revert CollateralTooLow();
        if (retireAt != 0) revert Retired();
        if (openPositionCount() >= MAX_OPEN_POSITIONS) {
            // A full market: the newcomer displaces the smallest position past its minimum hold if it is at least
            // DISPLACE_FACTOR times its size; that position is closed for its owner exactly as its own full close at
            // the oracle price would be (fee, profit cap; past the hold, so its profit is paid).
            (address smallest, uint256 s) = smallestMaturePosition();
            if (smallest == address(0) || sizeUsd < s * DISPLACE_FACTOR) revert TooManyPositions();
            _close(smallest, s, MODE_DISPLACED, 0);
            emit Displaced(smallest, account, s);
        }
        _accrue();
        (isLong ? _longAccounts : _shortAccounts).add(account);
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
        // An increase restarts the minimum hold (and so protects the position from displacement): it must add at
        // least minCollateral of size, so keeping a slot young costs real fees every hold period.
        if (sizeUsd != 0 && sizeUsd < minCollateral) revert SizeTooSmall();
        _accrue();
        _fold(p);
        (uint256 pr, uint256 fee) = _add(account, p, sizeUsd, collateral, maxSlippageBps);
        emit Increased(account, msg.sender, sizeUsd, collateral, pr, fee);
    }

    /// Shared by open and increase. sizeUsd == 0 adds margin only, which is allowed on hold. `fee` includes the
    /// open spread.
    function _add(address account, Position storage p, uint256 sizeUsd, uint256 collateral, uint256 maxSlippageBps)
        internal
        returns (uint256 pr, uint256 fee)
    {
        bool hold;
        (pr, hold,) = _quoteAndRecord();
        if (sizeUsd > 0) {
            if (hold) revert Hold();
            if (retireAt != 0) revert Retired();
        }

        uint256 tokens;
        (tokens, fee) = _fill(account, p, pr, sizeUsd, maxSlippageBps);
        if (collateral < fee) revert CollateralTooLow();
        uint256 kept = collateral - fee;

        p.size += sizeUsd;
        p.tokens += tokens;
        p.collateral += kept;
        Side storage side = p.isLong ? longs : shorts;
        side.size += sizeUsd;
        side.tokens += tokens;
        side.collateral += kept;

        if (p.collateral == 0 || p.size > p.collateral * MAX_LEVERAGE) revert Leverage();
        if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();
        // Every open and increase leaves a position worth its slot (review v2 M-2). Margin only is always allowed.
        if (sizeUsd > 0) _checkFloors(p);

        pool.lockCollateral(account, collateral, kept);
        if (sizeUsd > 0) {
            if (side.size > pool.liquidAssets() * oiCapBps / BPS) revert OiCap();
            _syncReserve();
        }
    }

    /// Fill of `sizeUsd` at oracle price `pr`: the fee plus the open spread, both charged on size (the spread
    /// as a fee rather than a worse fill price, so `tokens` stays size / price and a short of N tokens still
    /// hedges N spot tokens 1:1; to first order it is the same cost). Their sum is checked against
    /// `maxSlippageBps`. Margin only: neither, and the hold clock does not restart.
    function _fill(address account, Position storage p, uint256 pr, uint256 sizeUsd, uint256 maxSlippageBps)
        internal
        returns (uint256 tokens, uint256 fee)
    {
        uint256 costBps;
        if (sizeUsd > 0) {
            costBps = feeBpsFor(account) + openSpreadBps;
            p.openedAt = uint64(block.timestamp);
        }
        if (costBps > maxSlippageBps) revert SlippageExceeded(costBps, maxSlippageBps);
        fee = Math.mulDiv(sizeUsd, costBps, BPS, Math.Rounding.Ceil);
        tokens = Math.mulDiv(sizeUsd, ONE, pr, p.isLong ? Math.Rounding.Floor : Math.Rounding.Ceil);
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

    /// `settle`: settleHeld / settleRetired (anyone, whole position, no hold spread, no minimum-hold cap).
    /// `settlePrice` (settleHeld on a delisted token only): a feed round newer than `lastPrice`, used instead of it.
    function _decrease(address account, uint256 sizeUsd, bool settle, uint256 settlePrice) internal nonReentrant {
        _close(account, sizeUsd, settle ? MODE_SETTLE : MODE_TRADER, settlePrice);
    }

    uint8 internal constant MODE_TRADER = 0;
    uint8 internal constant MODE_SETTLE = 1;
    /// A full market's smallest position displaced by a bigger open: no auth, no hold spread (opens need a fresh
    /// price), but the minimum-hold profit cap applies as for the trader's own close.
    uint8 internal constant MODE_DISPLACED = 2;

    function _close(address account, uint256 sizeUsd, uint8 mode, uint256 settlePrice) internal {
        bool settle = mode == MODE_SETTLE;
        if (mode == MODE_TRADER) _auth(account);
        Position storage p = _positions[account];
        if (p.size == 0) revert NoPosition();
        if (sizeUsd == 0) revert ZeroSize();
        if (sizeUsd > p.size) sizeUsd = p.size;
        _accrue();
        _fold(p);

        (uint256 pr, bool hold,) = _quoteAndRecord();
        if (settlePrice != 0) pr = settlePrice;
        Exit memory x;
        x.exec = pr;
        if (hold && mode == MODE_TRADER) {
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
        int256 out = x.coll.toInt256() + _cappedNet(x, sizeUsd, !settle && _young(p)) - x.fee.toInt256();

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
            _forget(account, p.isLong);
            delete _positions[account];
        } else {
            if (p.size > p.collateral * MAX_LEVERAGE) revert Leverage();
            if (_equity(p, pr) < int256(p.size * MAINTENANCE_BPS / BPS)) revert Liquidatable();
            // A partial decrease may not leave dust behind (review v2 M-2): close in full instead.
            _checkFloors(p);
        }
        _syncReserve();
        pool.settle(account, x.payout, x.collateralOut);
        emit Decreased(account, msg.sender, sizeUsd, x.pnl, x.funding, x.borrow, x.fee, x.payout, x.exec);
    }

    /// The minimum collateral and the minimum size (also minCollateral) a position keeps after any open, increase or
    /// partial decrease.
    function _checkFloors(Position storage p) internal view {
        uint256 m = minCollateral;
        if (p.collateral < m) revert CollateralTooLow();
        if (p.size < m) revert SizeTooSmall();
    }

    /// Net profit of a realization (PnL - funding - borrow), capped at the reserve held for that size, and at 0
    /// for a position still inside its minimum hold (`young`).
    function _cappedNet(Exit memory x, uint256 sizeUsd, bool young) internal view returns (int256 net) {
        net = x.pnl - x.funding - x.borrow.toInt256();
        int256 cap = young ? int256(0) : (sizeUsd * maxProfitBps / BPS).toInt256();
        if (net > cap) net = cap;
    }

    function _young(Position storage p) internal view returns (bool) {
        return block.timestamp < uint256(p.openedAt) + minHoldSeconds;
    }

    function _youngMem(Position memory p) internal view returns (bool) {
        return block.timestamp < uint256(p.openedAt) + minHoldSeconds;
    }

    // ---------------------------------------------------------------- internals: accounting

    function _removeFromSide(Position storage p, uint256 size, uint256 tokens, uint256 coll) internal {
        Side storage side = p.isLong ? longs : shorts;
        side.size -= size;
        side.tokens -= tokens;
        side.collateral -= coll;
    }

    function _forget(address account, bool isLong) internal {
        (isLong ? _longAccounts : _shortAccounts).remove(account);
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

    /// Sum over one side's positions of PnL at `pr`, each clamped to [-collateral, size x maxProfitBps].
    function _setPnl(EnumerableSet.AddressSet storage set, bool isLong, uint256 pr) internal view returns (int256 v) {
        uint256 n = set.length();
        uint256 mp = maxProfitBps;
        for (uint256 i; i < n; i++) {
            Position storage p = _positions[set.at(i)];
            uint256 size = p.size;
            int256 x = _pnl(isLong, size, p.tokens, pr);
            int256 cap = (size * mp / BPS).toInt256();
            int256 floor = -p.collateral.toInt256();
            v += x > cap ? cap : x < floor ? floor : x;
        }
    }

    /// Valuer price, hold flag and feed time, or the last stored price and its time on hold if the Valuer
    /// reverts (e.g. token delisted).
    /// `at` is when the hold (if any) is measured from: the feed time, but never later than the calendar's end when
    /// an expired holiday table is what holds the price (else the hold would restart with every fresh round and the
    /// pool's LP exits would wait forever); for a reverting Valuer the later of `lastPriceAt` and `unpricedSince`
    /// (now, if no state-changing call has seen the revert yet).
    function _quote() internal view returns (uint256 pr, bool hold, uint256 at) {
        try valuer.quote(underlying) returns (Valuer.Quote memory q) {
            return _held(q);
        } catch {
            return (lastPrice, true, _unpricedAt());
        }
    }

    /// `_quote` for a state-changing call: records the price and its feed time, or the first time the Valuer was
    /// seen reverting.
    function _quoteAndRecord() internal returns (uint256 pr, bool hold, uint256 at) {
        try valuer.quote(underlying) returns (Valuer.Quote memory q) {
            (lastPrice, lastPriceAt) = (q.priceUsdPerToken, q.updatedAt);
            if (unpricedSince != 0) unpricedSince = 0;
            return _held(q);
        } catch {
            if (unpricedSince == 0) unpricedSince = _unpricedStart();
            return (lastPrice, true, _unpricedAt());
        }
    }

    function _held(Valuer.Quote memory q) internal view returns (uint256 pr, bool hold, uint256 at) {
        (pr, hold, at) = (q.priceUsdPerToken, q.hold, q.updatedAt);
        if (hold && valuer.marketCalendar()) {
            uint256 until = valuer.calendarValidUntil();
            if (until != 0 && block.timestamp >= until && until < at) at = until;
        }
    }

    /// settleHeld's price when the Valuer reverts (delisted token): the token's own feed, read directly, if it has a
    /// round newer than `lastPrice` (a delisted token's feed keeps publishing while its market trades elsewhere), else
    /// 0 (use `lastPrice`). Without it, a market nobody poked settled after the grace at a days-old price (review v3
    /// R3-PERP-6). The read never reverts, and the round is used only if it is sane (review v4 R4-PERP-2): positive,
    /// decimals at most 18, not in the future, at most the Valuer's maxStaleness older than the delisting, and within
    /// MAX_HELD_FEED_DEVIATION_BPS of `lastPrice` (a feed that broke, the usual reason to delist at once, must not
    /// price the settlement). Anything else leaves `lastPrice`.
    function _heldSettlePrice() internal view returns (uint256) {
        try valuer.quote(underlying) returns (Valuer.Quote memory) {
            return 0; // the Valuer answers: _decrease already uses (and records) its latest round
        } catch {}
        StockTokenRegistry.Entry memory e = valuer.registry().entry(underlying);
        if (e.feed.code.length == 0) return 0;
        AggregatorV3Interface f = AggregatorV3Interface(e.feed);
        uint256 answer;
        try f.latestRoundData() returns (uint80, int256 a, uint256, uint256 updatedAt, uint80) {
            if (a <= 0 || updatedAt <= lastPriceAt || updatedAt > block.timestamp) return 0;
            // Fresh when the trouble started (the delisting) or later: an ancient round is not a price.
            if (updatedAt + valuer.maxStaleness() < _unpricedStart()) return 0;
            answer = uint256(a);
        } catch {
            return 0;
        }
        uint8 dec;
        try f.decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return 0;
        }
        if (dec > 18) return 0;
        uint256 p = answer * 10 ** (18 - dec);
        if (!e.multiplierEmbedded) {
            try IStockToken(underlying).uiMultiplier() returns (uint256 m) {
                p = p * m / 1e18;
            } catch {
                return 0;
            }
        }
        uint256 last = lastPrice;
        uint256 band = last * MAX_HELD_FEED_DEVIATION_BPS / BPS;
        if (last == 0 || p > last + band || p + band < last) return 0;
        return p;
    }

    /// Hold start for a reverting Valuer: the later of the last recorded price time and when the trouble started.
    function _unpricedAt() internal view returns (uint256) {
        uint256 since = _unpricedStart();
        return since > lastPriceAt ? since : lastPriceAt;
    }

    /// When the Valuer started reverting, as far as this market can tell: the recorded observation; else, while the
    /// token is delisted, its delisting time; else now (the clock starts with the first look).
    function _unpricedStart() internal view returns (uint256) {
        if (unpricedSince != 0) return unpricedSince;
        StockTokenRegistry reg = valuer.registry();
        if (!reg.isCanonical(underlying)) {
            uint256 d = reg.delistedAt(underlying);
            if (d != 0 && d <= block.timestamp) return d;
        }
        return block.timestamp;
    }

    /// On hold for longer than HELD_GRACE since the price's feed time `at`.
    function _pastGrace(uint256 at) internal view returns (bool) {
        return block.timestamp > at + HELD_GRACE;
    }

    function _mulDivSigned(int256 x, uint256 n, uint256 d) internal pure returns (int256) {
        // Against the trader: an amount owed realizes rounded up, an amount received rounded down.
        if (x >= 0) return Math.mulDiv(uint256(x), n, d, Math.Rounding.Ceil).toInt256();
        return -(uint256(-x) * n / d).toInt256();
    }
}
