// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IPerpMarketValuation {
    /// Signed unrealized PnL of all traders in the market (asset units): positive = traders are up.
    function traderPnl() external view returns (int256);
    /// Accrue funding and borrow to now (no-op if already accrued this second).
    function accrue() external;
    /// True while the market prices open interest at a stale (hold) price, for at most its HELD_GRACE.
    function staleWithOpenInterest() external view returns (bool);
    /// True while the market has open interest on hold at all (no grace).
    function onHoldWithOpenInterest() external view returns (bool);
    /// Long plus short size (asset units).
    function openInterest() external view returns (uint256);
}

/// LP vault (ERC-4626 over USDG) that is the counterparty to every PerpMarket it lists.
///
/// Cash model: every USDG of the engine sits here. `traderCollateral` is the part owed back to open
/// positions; the rest (`liquidAssets`) belongs to LPs. Every market reserves its maximum possible trader
/// payout (`size x maxProfitBps`) here; opening is refused and LP withdrawals are capped so that
/// `liquidAssets >= totalReserved` always holds: whatever prices do, every capped trader profit can be paid.
///
/// Share price (`totalAssets`) also nets the markets' unrealized trader PnL, so an LP cannot leave just before
/// traders realize a gain. Deposits start a 24h redeem cooldown on the receiver, and shares cannot leave an
/// account (redeem or transfer) during its cooldown, so LPs cannot sandwich an oracle update. A transfer never
/// re-dates the receiver: otherwise anyone could freeze any LP's exit with 0-value or 1-wei transfers.
///
/// While any market prices open interest at a stale (hold) price, the share price is stale too, so deposits
/// and withdrawals wait for a fresh price (max* return 0, the calls revert MarketOnHold): nobody enters or
/// leaves ahead of a reprice that is already known off-chain. A held market with no open interest (e.g. a
/// delisted token) does not block. A hold never freezes exits for longer than the market's HELD_GRACE: after it,
/// the market values its open interest at the reserve (the most it can pay traders) and stops blocking
/// withdrawals; deposits stay closed until it reprices or its positions are settled (`settleHeld`), since a
/// deposit at that conservative price would dilute the LPs already in. The owner removes a market with no open
/// interest (`removeMarket`), so a dead market stops costing gas in every share-price read.
///
/// Deposits stay closed until the owner calls `openDeposits` (one-way), so the deploy lists every market while the
/// pool provably has no LP: a stranger's 1-unit deposit right after the pool is created can no longer make the
/// deploy's instant `addMarket` wait for a timelock and orphan it half-way (review v2 L-7).
contract PerpPool is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    /// Hard floor for the deploy-time REDEEM_COOLDOWN (mainnet/fork 24 hours, testnet 15 minutes).
    uint256 public constant MIN_REDEEM_COOLDOWN = 10 minutes;
    uint256 public immutable REDEEM_COOLDOWN;
    /// Hard floor for the deploy-time TIMELOCK (mainnet/fork 48 hours, testnet 15 minutes). Listing a market,
    /// changing the maker registrar, and (in every market) risk-param changes wait this long once LPs are in.
    uint256 public constant MIN_TIMELOCK = 10 minutes;
    uint256 public immutable TIMELOCK;
    /// A matured proposal must be applied within this long after its eta.
    uint256 public constant PROPOSAL_EXPIRY = 14 days;

    uint256 public traderCollateral;
    uint256 public totalReserved;
    address public makerRegistrar;
    /// False until the owner opens LP deposits (see the contract notes).
    bool public depositsOpen;

    address[] private _markets;
    mapping(address market => bool) public isMarket;
    mapping(address market => uint256) public reserveOf;
    mapping(address account => uint256) public lastDepositAt;
    mapping(address account => bool) public isMaker;
    mapping(address account => mapping(address operator => bool)) public isOperator;
    /// Timelocked changes: proposal id (marketId / registrarId) => time it may be applied.
    mapping(bytes32 id => uint256) public etaOf;
    /// Bumped on every ownership change and part of every proposal id: a proposal made under one owner (the
    /// deployer) is void for the next (review v2 L-6, applied to the perps proposals).
    uint256 public proposalNonce;

    event MarketAdded(address indexed market);
    event MarketRemoved(address indexed market);
    event ChangeProposed(bytes32 indexed id, uint256 eta);
    event ChangeCancelled(bytes32 indexed id);
    event MakerRegistrarSet(address indexed registrar);
    event MakerSet(address indexed account, bool maker);
    event OperatorSet(address indexed account, address indexed operator, bool allowed);
    event DepositsOpened();
    event ReserveUpdated(address indexed market, uint256 reserve, uint256 totalReserved);

    error NotMarket();
    error NotRegistrar();
    error ZeroAddress();
    error AlreadyMarket();
    error ReceiverNotSender();
    error Cooldown(uint256 until);
    error PoolCapacity(uint256 liquid, uint256 reserved);
    error CollateralUnderflow();
    error ZeroAmount();
    error MarketOnHold(address market);
    error CooldownTooShort();
    error OpenInterest(address market);
    error TimelockTooShort();
    error TimelockActive(bytes32 id, uint256 eta);
    error NotProposed(bytes32 id);
    error ProposalExpired(bytes32 id, uint256 eta);
    error DepositsClosed();
    error AlreadyOpen();

    modifier onlyMarket() {
        if (!isMarket[msg.sender]) revert NotMarket();
        _;
    }

    constructor(IERC20 usdg, address owner_, uint256 redeemCooldown_, uint256 timelock_)
        ERC20("Plynth Perp LP", "pPLP")
        ERC4626(usdg)
        Ownable(owner_)
    {
        if (redeemCooldown_ < MIN_REDEEM_COOLDOWN) revert CooldownTooShort();
        if (timelock_ < MIN_TIMELOCK) revert TimelockTooShort();
        REDEEM_COOLDOWN = redeemCooldown_;
        TIMELOCK = timelock_;
    }

    // ---------------------------------------------------------------- admin

    /// List a market (every LP becomes its counterparty). Instant while the pool has no LP shares (the deploy
    /// script lists everything before any deposit); otherwise TIMELOCK after `proposeMarket(market)`, so LPs
    /// who do not want the new exposure can leave first.
    function addMarket(address market) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        if (isMarket[market]) revert AlreadyMarket();
        if (totalSupply() != 0) _consume(marketId(market));
        isMarket[market] = true;
        _markets.push(market);
        emit MarketAdded(market);
    }

    /// Drop a market with no open interest (e.g. a delisted token whose positions were settled). Instant: it
    /// cannot move the share price (no positions, no reserve) and the market can no longer open positions.
    function removeMarket(address market) external onlyOwner {
        if (!isMarket[market]) revert NotMarket();
        if (IPerpMarketValuation(market).openInterest() != 0 || reserveOf[market] != 0) revert OpenInterest(market);
        isMarket[market] = false;
        uint256 n = _markets.length;
        for (uint256 i; i < n; i++) {
            if (_markets[i] == market) {
                _markets[i] = _markets[n - 1];
                _markets.pop();
                break;
            }
        }
        emit MarketRemoved(market);
    }

    /// The treasury factory (todo 14) becomes the registrar: it registers each TreasuryAccount it deploys, and a
    /// maker pays the maker fee (6 bps by default) instead of 10 (LP income). Instant while the pool has no LP shares or when clearing it
    /// (address(0) only stops new registrations); otherwise TIMELOCK after `proposeMakerRegistrar(registrar)`.
    function setMakerRegistrar(address registrar) external onlyOwner {
        if (totalSupply() != 0 && registrar != address(0)) _consume(registrarId(registrar));
        makerRegistrar = registrar;
        emit MakerRegistrarSet(registrar);
    }

    /// Opens LP deposits, for good. The deploy calls it once every market is listed.
    function openDeposits() external onlyOwner {
        if (depositsOpen) revert AlreadyOpen();
        depositsOpen = true;
        emit DepositsOpened();
    }

    function proposeMarket(address market) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        _propose(marketId(market));
    }

    function proposeMakerRegistrar(address registrar) external onlyOwner {
        _propose(registrarId(registrar));
    }

    function cancel(bytes32 id) external onlyOwner {
        if (etaOf[id] == 0) revert NotProposed(id);
        delete etaOf[id];
        emit ChangeCancelled(id);
    }

    function marketId(address market) public view returns (bytes32) {
        return keccak256(abi.encode(proposalNonce, "addMarket", market));
    }

    function registrarId(address registrar) public view returns (bytes32) {
        return keccak256(abi.encode(proposalNonce, "makerRegistrar", registrar));
    }

    function _propose(bytes32 id) internal {
        uint256 eta = block.timestamp + TIMELOCK;
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

    function setMaker(address account, bool maker) external {
        if (msg.sender != makerRegistrar) revert NotRegistrar();
        isMaker[account] = maker;
        emit MakerSet(account, maker);
    }

    function markets() external view returns (address[] memory) {
        return _markets;
    }

    // ---------------------------------------------------------------- operators

    /// Authorize a trade-only operator for msg.sender on every market of this pool. Operators can open,
    /// increase, decrease and close; collateral is pulled from and proceeds are paid to the account only.
    function setOperator(address operator, bool allowed) external {
        isOperator[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    // ---------------------------------------------------------------- views

    /// USDG that belongs to LPs in cash (excludes trader collateral; ignores unrealized PnL).
    function liquidAssets() public view returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > traderCollateral ? bal - traderCollateral : 0;
    }

    /// LP equity: cash minus what traders are up (plus what they are down) across markets, each position valued
    /// on its own by its market (floored at minus its collateral, capped at its maximum payout).
    function totalAssets() public view override returns (uint256) {
        int256 v = int256(liquidAssets());
        for (uint256 i; i < _markets.length; i++) {
            v -= IPerpMarketValuation(_markets[i]).traderPnl();
        }
        return v > 0 ? uint256(v) : 0;
    }

    /// Cash LPs may take out now without breaking the reserve.
    function freeAssets() public view returns (uint256) {
        uint256 l = liquidAssets();
        return l > totalReserved ? l - totalReserved : 0;
    }

    /// The first market whose open interest is priced at a stale price, or address(0).
    function heldMarket() public view returns (address) {
        for (uint256 i; i < _markets.length; i++) {
            if (IPerpMarketValuation(_markets[i]).staleWithOpenInterest()) return _markets[i];
        }
        return address(0);
    }

    /// The first market with open interest on hold at all (grace or not), or address(0): deposits wait for it.
    function heldMarketForDeposits() public view returns (address) {
        for (uint256 i; i < _markets.length; i++) {
            if (IPerpMarketValuation(_markets[i]).onHoldWithOpenInterest()) return _markets[i];
        }
        return address(0);
    }

    function _notHeld() internal view {
        address m = heldMarket();
        if (m != address(0)) revert MarketOnHold(m);
    }

    function _notHeldForDeposits() internal view {
        address m = heldMarketForDeposits();
        if (m != address(0)) revert MarketOnHold(m);
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (!depositsOpen || heldMarketForDeposits() != address(0)) return 0;
        return super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (!depositsOpen || heldMarketForDeposits() != address(0)) return 0;
        return super.maxMint(receiver);
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (heldMarket() != address(0)) return 0;
        if (block.timestamp < lastDepositAt[owner_] + REDEEM_COOLDOWN) return 0;
        return Math.min(super.maxWithdraw(owner_), freeAssets());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (heldMarket() != address(0)) return 0;
        if (block.timestamp < lastDepositAt[owner_] + REDEEM_COOLDOWN) return 0;
        return Math.min(super.maxRedeem(owner_), _convertToShares(freeAssets(), Math.Rounding.Floor));
    }

    // ---------------------------------------------------------------- LP entry points

    /// Deposits only for oneself: a deposit restarts the receiver's cooldown, so letting anyone deposit for
    /// anyone would let a stranger lock an LP in forever with 1 wei.
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        if (receiver != msg.sender) revert ReceiverNotSender();
        if (assets == 0) revert ZeroAmount();
        if (!depositsOpen) revert DepositsClosed();
        _notHeldForDeposits();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        if (receiver != msg.sender) revert ReceiverNotSender();
        if (shares == 0) revert ZeroAmount();
        if (!depositsOpen) revert DepositsClosed();
        _notHeldForDeposits();
        return super.mint(shares, receiver);
    }

    /// Funding rates divide by `liquidAssets`, so every market is accrued at the old liquidity before any
    /// change to it: a rate computed now is never applied to an interval that had different liquidity.
    function _accrueMarkets() internal {
        for (uint256 i; i < _markets.length; i++) {
            IPerpMarketValuation(_markets[i]).accrue();
        }
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override returns (uint256) {
        _notHeld();
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override returns (uint256) {
        _notHeld();
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        _accrueMarkets();
        lastDepositAt[receiver] = block.timestamp;
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 until = lastDepositAt[owner_] + REDEEM_COOLDOWN;
        if (block.timestamp < until) revert Cooldown(until);
        _accrueMarkets();
        super._withdraw(caller, receiver, owner_, assets, shares);
        if (liquidAssets() < totalReserved) revert PoolCapacity(liquidAssets(), totalReserved);
    }

    /// Shares in cooldown cannot be transferred (any amount, including 0), so a transfer cannot skip the
    /// cooldown; the receiver's own cooldown is left alone.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 until = lastDepositAt[from] + REDEEM_COOLDOWN;
            if (block.timestamp < until) revert Cooldown(until);
        }
        super._update(from, to, value);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------- market hooks

    /// Pull `amountIn` from `from`; `kept` of it becomes trader collateral, the rest (fees) goes to LPs.
    function lockCollateral(address from, uint256 amountIn, uint256 kept) external onlyMarket {
        _accrueMarkets();
        if (amountIn > 0) IERC20(asset()).safeTransferFrom(from, address(this), amountIn);
        traderCollateral += kept;
    }

    /// Release `collateralOut` of trader collateral and pay `payout` to `to` (the difference, either way,
    /// is the LPs' gain or loss).
    function settle(address to, uint256 payout, uint256 collateralOut) external onlyMarket {
        if (collateralOut > traderCollateral) revert CollateralUnderflow();
        _accrueMarkets();
        traderCollateral -= collateralOut;
        if (payout > 0) IERC20(asset()).safeTransfer(to, payout);
        if (liquidAssets() < totalReserved) revert PoolCapacity(liquidAssets(), totalReserved);
    }

    /// Set this market's reserve. An increase must still be covered by LP cash.
    function setReserve(uint256 reserve) external onlyMarket {
        uint256 old = reserveOf[msg.sender];
        reserveOf[msg.sender] = reserve;
        totalReserved = totalReserved - old + reserve;
        if (reserve > old && liquidAssets() < totalReserved) revert PoolCapacity(liquidAssets(), totalReserved);
        emit ReserveUpdated(msg.sender, reserve, totalReserved);
    }
}
