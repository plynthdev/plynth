// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams, V4Constants} from "../interfaces/IUniswapV4.sol";

interface IStakingRewards {
    function notifyReward(address token, uint256 amount) external;
}

/// The TreasuryFactory view the router uses to attribute a close fee to a template author.
interface ITemplateFeeSource {
    function closeAuthor(address close) external view returns (address account, address author);
}

interface IInsuranceFees {
    function totalShares() external view returns (uint256);
    function depositFees(uint256 amount) external;
}

/// Receives platform fees in USDG (PeriodClose pays its 25 bps/yr fee here) and splits them on `push()`:
///
/// 1. the template-author share comes off first: when a PeriodClose of a treasury built from a marketplace
///    template pays its fee, it calls `onCloseFee` and `authorBps` (20% in production, at most 20%) of that fee
///    is set aside for the template's author (`authorOwed`, claimed with `claimAuthor`). The router checks with
///    the TreasuryFactory (`closeAuthor`) that the caller is a PeriodClose it made, so nobody can claim fees
///    for a treasury they do not close. Set-aside USDG is never part of a push;
/// 2. half of the rest buys PLTH on the PLTH/USDG Uniswap v4 pool and the PLTH goes to stakers;
/// 3. the other half goes to the ExceptionInsurancePool, unless the pool has no depositors (no LP shares):
///    then it goes to stakers as USDG, so the first LP cannot walk in and take fees nobody was insuring.
///
/// `push()` is open to anyone but runs at most once per hour, so nobody can time a large reward to a moment
/// that suits them (the staking side also only pays stake that was active for a whole hour).
///
/// The buy is oracle-free (PLTH has no feed): the minimum output is the pool's own spot price (slot0, read
/// with `extsload`) less `maxSlippageBps`, and at most `perPushCap` USDG is spent per push. The spot read is
/// in the same transaction as the swap, so it bounds the trade's own price impact, not a pool someone moved
/// beforehand; the per-push cap is what bounds the loss to a sandwich, and the hourly rate limit bounds how
/// often it can be tried. Whatever is not spent (over the cap, or a buy that would breach the slippage
/// bound, which is skipped instead of reverting the push) is carried in `buyCarry` for the next push and is
/// never re-split. The router keeps no other balance between pushes (besides the authors' set-aside USDG).
contract FeeRouter is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using V4Constants for int256;

    uint256 public constant PUSH_INTERVAL = 1 hours;
    uint16 public constant MAX_AUTHOR_BPS = 2000;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 1 << 96;

    IERC20 public immutable usdg;
    IERC20 public immutable plth;
    IStakingRewards public immutable staking;
    IInsuranceFees public immutable insurance;
    IPoolManager public immutable poolManager;
    bool public immutable usdgIs0;
    PoolKey private _key;

    ITemplateFeeSource public templateSource; // the TreasuryFactory; zero = no author share
    uint16 public authorBps;
    uint256 public authorReserved; // USDG set aside for authors, not yet claimed
    uint256 public authorSincePush; // author share set aside since the last push (reported in Pushed)
    mapping(address author => uint256) public authorOwed;
    uint16 public maxSlippageBps;
    uint256 public perPushCap; // USDG raw units spent on PLTH per push at most
    uint256 public buyCarry; // USDG earmarked for buys, not yet spent
    uint64 public lastPush;

    event Pushed(
        uint256 fees,
        uint256 toAuthor,
        uint256 toInsurance,
        uint256 usdgToStakers,
        uint256 usdgSpent,
        uint256 plthBought,
        uint256 buyCarry
    );
    event BuySkipped(uint256 usdgIn, uint256 minOut);
    event TemplateFeesSet(address source, uint16 bps);
    event AuthorAccrued(address indexed account, address indexed author, uint256 amount);
    event AuthorClaimed(address indexed author, uint256 amount);
    event BuyParamsSet(uint16 maxSlippageBps, uint256 perPushCap);

    error ZeroAddress();
    error BadPoolKey();
    error TooSoon(uint64 nextPushAt);
    error BadParams();
    error NotPoolManager();
    error NotSelf();
    error PartialFill(uint256 wanted, uint256 used);
    error Slippage(uint256 minOut, uint256 got);
    error NotTreasuryClose(address caller);
    error NothingOwed();

    constructor(
        IERC20 usdg_,
        IERC20 plth_,
        IStakingRewards staking_,
        IInsuranceFees insurance_,
        IPoolManager pm,
        PoolKey memory key,
        uint16 maxSlippageBps_,
        uint256 perPushCap_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(usdg_) == address(0) || address(plth_) == address(0) || address(staking_) == address(0)
                || address(insurance_) == address(0) || address(pm) == address(0)
        ) revert ZeroAddress();
        bool ok = (key.currency0 == address(usdg_) && key.currency1 == address(plth_))
            || (key.currency0 == address(plth_) && key.currency1 == address(usdg_));
        if (!ok || address(key.hooks) != address(0)) revert BadPoolKey();
        usdg = usdg_;
        plth = plth_;
        staking = staking_;
        insurance = insurance_;
        poolManager = pm;
        usdgIs0 = key.currency0 == address(usdg_);
        _key = key;
        _setBuyParams(maxSlippageBps_, perPushCap_);
    }

    // ---------------------------------------------------------------- owner

    /// Template-author carve-out: `source` is the TreasuryFactory, `bps` the author share of a templated
    /// treasury's fee (at most 20%). `source` zero turns it off.
    function setTemplateFees(ITemplateFeeSource source, uint16 bps) external onlyOwner {
        if (bps > MAX_AUTHOR_BPS || (address(source) == address(0) && bps != 0)) revert BadParams();
        templateSource = source;
        authorBps = bps;
        emit TemplateFeesSet(address(source), bps);
    }

    function setBuyParams(uint16 maxSlippageBps_, uint256 perPushCap_) external onlyOwner {
        _setBuyParams(maxSlippageBps_, perPushCap_);
    }

    // ---------------------------------------------------------------- template authors

    /// Called by a PeriodClose right after it paid `amount` USDG here for `account`. Sets the author share aside
    /// if the treasury was built from a template; does nothing otherwise.
    function onCloseFee(address account, uint256 amount) external {
        if (address(templateSource) == address(0) || authorBps == 0) return;
        (address acct, address author) = templateSource.closeAuthor(msg.sender);
        if (acct == address(0) || acct != account) revert NotTreasuryClose(msg.sender);
        if (author == address(0)) return;
        uint256 cut = amount * authorBps / BPS;
        uint256 free = usdg.balanceOf(address(this)) - buyCarry - authorReserved;
        if (cut > free) cut = free; // never set aside USDG that is not here
        if (cut == 0) return;
        authorOwed[author] += cut;
        authorReserved += cut;
        authorSincePush += cut;
        emit AuthorAccrued(account, author, cut);
    }

    function claimAuthor() external nonReentrant returns (uint256 amount) {
        amount = authorOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        authorOwed[msg.sender] = 0;
        authorReserved -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit AuthorClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------- push

    function push() external nonReentrant {
        uint64 next = lastPush + uint64(PUSH_INTERVAL);
        if (lastPush != 0 && block.timestamp < next) revert TooSoon(next);
        lastPush = uint64(block.timestamp);

        uint256 rest = usdg.balanceOf(address(this)) - buyCarry - authorReserved;
        uint256 toAuthor = authorSincePush;
        authorSincePush = 0;
        uint256 fees = rest + toAuthor;
        uint256 toBuy = rest / 2;
        uint256 insHalf = rest - toBuy;

        uint256 toInsurance;
        uint256 usdgToStakers;
        if (insHalf != 0) {
            if (insurance.totalShares() == 0) {
                usdgToStakers = insHalf;
                usdg.forceApprove(address(staking), insHalf);
                staking.notifyReward(address(usdg), insHalf);
            } else {
                toInsurance = insHalf;
                usdg.forceApprove(address(insurance), insHalf);
                insurance.depositFees(insHalf);
            }
        }

        uint256 spendable = buyCarry + toBuy;
        uint256 spend = spendable < perPushCap ? spendable : perPushCap;
        uint256 bought;
        if (spend != 0) {
            uint256 minOut = quoteMinOut(spend);
            try this.buyExternal(spend, minOut) returns (uint256 out) {
                bought = out;
            } catch {
                emit BuySkipped(spend, minOut);
                spend = 0;
            }
        }
        buyCarry = spendable - spend;
        if (bought != 0) {
            plth.forceApprove(address(staking), bought);
            staking.notifyReward(address(plth), bought);
        }
        emit Pushed(fees, toAuthor, toInsurance, usdgToStakers, spend, bought, buyCarry);
    }

    /// Only callable by this contract (so `push` can catch a failed buy and carry the USDG).
    function buyExternal(uint256 usdgIn, uint256 minOut) external returns (uint256 out) {
        if (msg.sender != address(this)) revert NotSelf();
        out = abi.decode(poolManager.unlock(abi.encode(usdgIn, minOut)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));
        bool zeroForOne = usdgIs0;
        int256 delta = poolManager.swap(
            _key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? V4Constants.MIN_SQRT_PRICE_LIMIT : V4Constants.MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 used = dIn < 0 ? uint256(int256(-dIn)) : 0;
        if (used != amountIn) revert PartialFill(amountIn, used);
        uint256 out = dOut > 0 ? uint256(int256(dOut)) : 0;
        if (out < minOut) revert Slippage(minOut, out);
        poolManager.sync(address(usdg));
        usdg.safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(address(plth), address(this), out);
        return abi.encode(out);
    }

    // ---------------------------------------------------------------- views

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function poolId() public view returns (bytes32) {
        return keccak256(abi.encode(_key));
    }

    /// Pool spot price as sqrtPriceX96 (slot0, low 160 bits of the pool's first storage word).
    function spotSqrtPriceX96() public view returns (uint160) {
        bytes32 slot = keccak256(abi.encode(poolId(), V4Constants.POOLS_SLOT));
        return uint160(uint256(poolManager.extsload(slot)));
    }

    /// PLTH raw units `usdgIn` buys at spot (before LP fee), less `maxSlippageBps`. The bound must leave room
    /// for the pool fee (e.g. 0.3%) or every buy is skipped.
    function quoteMinOut(uint256 usdgIn) public view returns (uint256) {
        uint256 sp = spotSqrtPriceX96();
        if (sp == 0) return type(uint256).max; // uninitialised pool: never buy
        uint256 atSpot = usdgIs0
            ? Math.mulDiv(Math.mulDiv(usdgIn, sp, Q96), sp, Q96) // token1 per token0 = sp^2 / 2^192
            : Math.mulDiv(Math.mulDiv(usdgIn, Q96, sp), Q96, sp);
        return Math.mulDiv(atSpot, BPS - maxSlippageBps, BPS);
    }

    function _setBuyParams(uint16 s, uint256 cap) private {
        if (s > MAX_SLIPPAGE_BPS || cap == 0) revert BadParams();
        maxSlippageBps = s;
        perPushCap = cap;
        emit BuyParamsSet(s, cap);
    }
}
