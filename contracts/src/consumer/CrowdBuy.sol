// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {SavingsVault} from "./SavingsVault.sol";
import {StockRouter} from "../core/StockRouter.sol";
import {Valuer} from "../core/Valuer.sol";

interface IExecuteBeacon {
    function executeAfter(bytes32 key) external view returns (uint64);
}

/// Pools many small USDG buys of one Stock Token into one swap.
///
/// Each asset has one open "book". `join` sweeps a saver's pending USDG out of the SavingsVault and splits
/// it by the saver's mix into each asset's open book. A book executes (one router swap for its whole USDG
/// total) once it has at least MIN_CROWD distinct accounts AND the current 24h window's jittered beacon time
/// has passed. If the crowd is too small when a window ends nothing happens: the same book simply stays open
/// into the next window. At most one execution per asset per window. No per-user loops anywhere.
///
/// Allocation proof: there is no Merkle tree because everything is computable on-chain. A user's order is
/// the sum of their `Joined` events for (asset, bookId) minus a `Cancelled` event; the book total, raw tokens
/// out, account count and oracle round are in `Executed`; `allocationOf(asset, bookId, user)` returns
/// floor(rawOut * order / usdgTotal) in raw token units. Anyone can recompute it from logs and compare.
///
/// Units: allocations are raw Stock Token base units and are never scaled by `uiMultiplier`, so a
/// multiplier change (split, dividend) after execution cannot change anyone's allocation.
/// Dust (rawOut minus the sum of floored allocations) stays here; it is added to `dust[asset]` when the
/// last account of a book has settled (claimed or delivered), so `dust` is exact, never an estimate.
///
/// Exit: `claimOpen` is never gated by the user's delivery mode, the keeper or the owner. A Quiet/Hidden
/// user who claims openly receives tokens at their own address (a documented privacy cost).
/// Trust: the owner can only rotate the keeper; the keeper can only deliver (a stub until todos 09/16).
/// Nobody can move pooled USDG anywhere except into the router for that book or back to the vault on cancel.
contract CrowdBuy is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Book {
        uint256 usdgTotal;
        uint32 accounts;
        uint64 openedAt;
        uint256 rawOut;
        bool executed;
    }

    struct Settlement {
        uint32 settledAccounts; // accounts that have claimed or been delivered
        uint256 settledRaw; // raw tokens paid out so far
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    uint64 public constant WINDOW = 1 days;
    uint256 private constant BPS = 10_000;

    SavingsVault public immutable vault;
    StockRouter public immutable router;
    IExecuteBeacon public immutable beacon;
    Valuer public immutable valuer;
    IERC20 public immutable usdg;
    uint32 public immutable MIN_CROWD;
    uint16 public immutable slippageBps;
    uint64 public immutable GENESIS;

    address public keeper;

    mapping(address asset => uint256) public currentBookId;
    mapping(address asset => mapping(uint256 bookId => Book)) private _books;
    mapping(address asset => mapping(uint256 bookId => Settlement)) private _settlements;
    mapping(address asset => mapping(uint256 bookId => mapping(address user => uint256))) public orderOf;
    mapping(address asset => mapping(uint256 bookId => mapping(address user => bool))) public settled;
    mapping(address asset => uint64) public lastExecutedWindow; // windowStart + 1, 0 = never
    mapping(address asset => uint256) public dust;

    event KeeperSet(address indexed keeper);
    event BookOpened(address indexed asset, uint256 indexed bookId, uint64 openedAt);
    event Joined(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg);
    event Cancelled(address indexed asset, uint256 indexed bookId, address indexed user, uint256 usdg);
    event Executed(
        address indexed asset, uint256 indexed bookId, uint256 usdgTotal, uint256 rawOut, uint32 accounts, uint80 roundId
    );
    event Claimed(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw);
    event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw);
    event DustSettled(address indexed asset, uint256 indexed bookId, uint256 raw);

    error ZeroAddress();
    error BadParam();
    error NotKeeper();
    error NothingPending();
    error NoOrder();
    error AlreadyExecuted();
    error NotExecuted();
    error AlreadySettled();
    error CrowdTooSmall(uint32 accounts, uint32 minCrowd);
    error TooEarly(uint64 executeAfter);
    error AlreadyExecutedThisWindow(uint64 windowStart);
    error MarketOnHold(address asset);
    error BeforeGenesis();
    error NotYet();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        SavingsVault vault_,
        StockRouter router_,
        IExecuteBeacon beacon_,
        uint32 minCrowd_,
        uint16 slippageBps_,
        uint64 genesis_,
        address owner_,
        address keeper_
    ) Ownable(owner_) {
        if (address(vault_) == address(0) || address(router_) == address(0) || address(beacon_) == address(0)) {
            revert ZeroAddress();
        }
        if (minCrowd_ == 0 || slippageBps_ > MAX_SLIPPAGE_BPS) revert BadParam();
        vault = vault_;
        router = router_;
        beacon = beacon_;
        valuer = router_.valuer();
        usdg = vault_.usdg();
        if (address(router_.usdg()) != address(usdg)) revert BadParam();
        MIN_CROWD = minCrowd_;
        slippageBps = slippageBps_;
        GENESIS = genesis_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    // ---------------------------------------------------------------- orders

    /// Anyone may call for any user: it only moves that user's own pending USDG into that user's own orders.
    /// Split by mix weight (floor); the last mix entry takes the remainder so the whole sweep is placed.
    /// Deliberately not nonReentrant: a join that lands while a book is executing goes to the new book (R8).
    function join(address user) external {
        (SavingsVault.MixEntry[] memory mix, uint256 amount) = vault.sweep(user);
        if (amount == 0) revert NothingPending();
        uint256 n = mix.length;
        uint256 placed;
        for (uint256 i; i < n; ++i) {
            uint256 part = i == n - 1 ? amount - placed : amount * mix[i].weightBps / BPS;
            placed += part;
            if (part != 0) _addOrder(mix[i].stockToken, user, part);
        }
    }

    /// Cancels msg.sender's whole order in a not-yet-executed book; the USDG goes back to their vault balance.
    function cancel(address asset, uint256 bookId) external nonReentrant {
        Book storage b = _books[asset][bookId];
        if (b.executed) revert AlreadyExecuted();
        uint256 order = orderOf[asset][bookId][msg.sender];
        if (order == 0) revert NoOrder();
        orderOf[asset][bookId][msg.sender] = 0;
        b.usdgTotal -= order;
        b.accounts -= 1;
        usdg.forceApprove(address(vault), order);
        vault.refundFromCrowd(msg.sender, order);
        emit Cancelled(asset, bookId, msg.sender, order);
    }

    // ---------------------------------------------------------------- execution

    /// Fixed 24h grid from GENESIS.
    function windowOf(uint256 t) public view returns (uint64 start, uint64 end) {
        if (t < GENESIS) revert BeforeGenesis();
        start = GENESIS + uint64((t - GENESIS) / WINDOW) * WINDOW;
        end = start + WINDOW;
    }

    /// The JitterBeacon key the keeper commits for (asset, window): keccak256(abi.encode(asset, windowStart)).
    function beaconKey(address asset, uint64 windowStart) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, windowStart));
    }

    /// Anyone. Requires: crowd >= MIN_CROWD, the window's beacon time has passed, not yet executed this window,
    /// and the oracle is not on hold (stale/off-hours). The router enforces an oracle-based minOut.
    function execute(address asset) external nonReentrant {
        uint256 bookId = currentBookId[asset];
        Book storage b = _books[asset][bookId];
        if (b.executed) revert AlreadyExecuted(); // unreachable: the current book is never executed
        if (b.accounts < MIN_CROWD) revert CrowdTooSmall(b.accounts, MIN_CROWD);
        (uint64 start,) = windowOf(block.timestamp);
        if (lastExecutedWindow[asset] == start + 1) revert AlreadyExecutedThisWindow(start);
        uint64 after_ = beacon.executeAfter(beaconKey(asset, start));
        if (block.timestamp < after_) revert TooEarly(after_);
        Valuer.Quote memory q = valuer.quote(asset);
        if (q.hold) revert MarketOnHold(asset);

        // Effects before the swap: from here on, joins land in the next book.
        uint256 total = b.usdgTotal;
        uint32 accounts = b.accounts;
        b.executed = true;
        lastExecutedWindow[asset] = start + 1;
        _openNext(asset, bookId);

        IERC20 token = IERC20(asset);
        uint256 before = token.balanceOf(address(this));
        usdg.forceApprove(address(router), total);
        router.buy(asset, total, slippageBps, address(this));
        uint256 rawOut = token.balanceOf(address(this)) - before;
        b.rawOut = rawOut;
        emit Executed(asset, bookId, total, rawOut, accounts, q.roundId);
    }

    // ---------------------------------------------------------------- settlement

    /// floor(rawOut * order / usdgTotal), raw token units. 0 before execution.
    function allocationOf(address asset, uint256 bookId, address user) public view returns (uint256 raw) {
        Book storage b = _books[asset][bookId];
        if (!b.executed || b.usdgTotal == 0) return 0;
        return Math.mulDiv(b.rawOut, orderOf[asset][bookId][user], b.usdgTotal);
    }

    /// The ungated exit: always allowed for the user's own allocation, whatever their delivery mode.
    function claimOpen(address asset, uint256 bookId) external nonReentrant {
        uint256 raw = _settle(asset, bookId, msg.sender);
        if (raw != 0) IERC20(asset).safeTransfer(msg.sender, raw);
        emit Claimed(asset, bookId, msg.sender, raw);
    }

    /// Quiet (todo 09) and Hidden (todo 16) delivery routes. Not built yet.
    function deliver(address, uint256, address, bytes calldata) external view onlyKeeper {
        revert NotYet();
    }

    // ---------------------------------------------------------------- views

    function book(address asset, uint256 bookId) external view returns (Book memory) {
        return _books[asset][bookId];
    }

    function openBook(address asset) external view returns (uint256 bookId, Book memory b) {
        bookId = currentBookId[asset];
        b = _books[asset][bookId];
    }

    function settlement(address asset, uint256 bookId) external view returns (Settlement memory) {
        return _settlements[asset][bookId];
    }

    // ---------------------------------------------------------------- internal

    function _addOrder(address asset, address user, uint256 amount) private {
        uint256 bookId = currentBookId[asset];
        Book storage b = _books[asset][bookId];
        if (b.openedAt == 0) {
            b.openedAt = uint64(block.timestamp);
            emit BookOpened(asset, bookId, b.openedAt);
        }
        mapping(address => uint256) storage orders = orderOf[asset][bookId];
        if (orders[user] == 0) b.accounts += 1;
        orders[user] += amount;
        b.usdgTotal += amount;
        emit Joined(asset, bookId, user, amount);
    }

    function _openNext(address asset, uint256 bookId) private {
        uint256 next = bookId + 1;
        currentBookId[asset] = next;
        uint64 t = uint64(block.timestamp);
        _books[asset][next].openedAt = t;
        emit BookOpened(asset, next, t);
    }

    /// Marks `user` settled for the book and returns their allocation. When the last account settles,
    /// whatever was not allocated becomes dust.
    function _settle(address asset, uint256 bookId, address user) private returns (uint256 raw) {
        Book storage b = _books[asset][bookId];
        if (!b.executed) revert NotExecuted();
        if (orderOf[asset][bookId][user] == 0) revert NoOrder();
        if (settled[asset][bookId][user]) revert AlreadySettled();
        settled[asset][bookId][user] = true;
        raw = allocationOf(asset, bookId, user);
        Settlement storage s = _settlements[asset][bookId];
        s.settledAccounts += 1;
        s.settledRaw += raw;
        if (s.settledAccounts == b.accounts) {
            uint256 d = b.rawOut - s.settledRaw;
            dust[asset] += d;
            emit DustSettled(asset, bookId, d);
        }
    }
}
