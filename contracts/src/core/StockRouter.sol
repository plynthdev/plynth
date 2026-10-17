// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams, V4Constants} from "../interfaces/IUniswapV4.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";
import {Valuer} from "./Valuer.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";

/// Buys and sells canonical Stock Tokens for USDG through one Uniswap v4 pool per token.
/// Exact-input swaps only. The minimum output comes from the oracle (Valuer), never from the pool,
/// so a manipulated or thin pool cannot fill a trade far from the oracle price.
/// USDG is valued at exactly 1 USD (the USDG/USD feed has sat at 1.0001; depeg handling is out of scope).
/// The router never keeps a balance: input is pulled from the caller and output goes to `recipient`
/// in the same transaction; a partial fill reverts so no input can be left behind.
/// Admin: setting a token's first pool applies at once; replacing a pool waits CHANGE_DELAY (48 h) in public, so the
/// owner cannot switch a token to a pool it controls under users' pending trades.
contract StockRouter is Ownable, IUnlockCallback, ChangeDelay {
    using SafeERC20 for IERC20;
    using V4Constants for int256;

    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    StockTokenRegistry public immutable registry;
    Valuer public immutable valuer;
    IERC20Metadata public immutable usdg;
    uint8 public immutable usdgDecimals; // read from the token at deploy (R5), never assumed

    mapping(address stockToken => PoolKey) private _pools;

    struct SwapData {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address recipient;
        PoolKey key;
    }

    event PoolSet(address indexed stockToken, bytes32 indexed poolId);
    event Bought(address indexed stockToken, address indexed payer, address indexed recipient, uint256 usdgIn, uint256 rawOut);
    event Sold(address indexed stockToken, address indexed payer, address indexed recipient, uint256 rawIn, uint256 usdgOut);

    error NotCanonical(address token);
    error MarketOnHold(address token);
    error Slippage(uint256 minOut, uint256 got);
    error SlippageTooHigh(uint16 bps);
    error NoPool(address token);
    error BadPoolKey();
    error ZeroAmount();
    error ZeroAddress();
    error NotPoolManager();
    error PartialFill(uint256 wanted, uint256 used);

    constructor(IPoolManager pm, StockTokenRegistry registry_, Valuer valuer_, IERC20Metadata usdg_, address owner_)
        Ownable(owner_)
    {
        if (address(pm) == address(0) || address(registry_) == address(0) || address(valuer_) == address(0)
            || address(usdg_) == address(0)) revert ZeroAddress();
        poolManager = pm;
        registry = registry_;
        valuer = valuer_;
        usdg = usdg_;
        usdgDecimals = usdg_.decimals();
    }

    /// Sets the v4 pool used for `stockToken`. The key must pair exactly USDG and `stockToken`.
    function setPool(address stockToken, PoolKey calldata key) external onlyOwner {
        bool ok = (key.currency0 == address(usdg) && key.currency1 == stockToken)
            || (key.currency0 == stockToken && key.currency1 == address(usdg));
        if (!ok || stockToken == address(0)) revert BadPoolKey();
        PoolKey memory cur = _pools[stockToken];
        if (keccak256(abi.encode(cur)) == keccak256(abi.encode(key))) return; // unchanged: nothing to delay
        if ((cur.currency0 != address(0) || cur.currency1 != address(0)) && !_delayed()) return;
        _pools[stockToken] = key;
        emit PoolSet(stockToken, keccak256(abi.encode(key)));
    }

    /// Drops a queued change (see ChangeDelay).
    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    function poolOf(address stockToken) external view returns (PoolKey memory) {
        return _pools[stockToken];
    }

    /// Pays `usdgIn` USDG from msg.sender, sends the Stock Tokens bought to `recipient`.
    function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient)
        external
        returns (uint256 rawOut)
    {
        uint256 minOut = _checkedMinOut(stockToken, usdgIn, true, maxSlippageBps, recipient);
        IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), usdgIn);
        rawOut = _swap(SwapData(address(usdg), stockToken, usdgIn, minOut, recipient, _pools[stockToken]));
        emit Bought(stockToken, msg.sender, recipient, usdgIn, rawOut);
    }

    /// Pays `rawIn` Stock Token base units from msg.sender, sends the USDG received to `recipient`.
    function sell(address stockToken, uint256 rawIn, uint16 maxSlippageBps, address recipient)
        external
        returns (uint256 usdgOut)
    {
        uint256 minOut = _checkedMinOut(stockToken, rawIn, false, maxSlippageBps, recipient);
        IERC20(stockToken).safeTransferFrom(msg.sender, address(this), rawIn);
        usdgOut = _swap(SwapData(stockToken, address(usdg), rawIn, minOut, recipient, _pools[stockToken]));
        emit Sold(stockToken, msg.sender, recipient, rawIn, usdgOut);
    }

    /// Oracle-derived minimum output. `hold` is true when the feed is stale (trading would revert).
    ///
    /// Notation: p = valuer price, USD per one whole token, 1e18-scaled; ud = USDG decimals;
    /// td = Stock Token decimals; s = maxSlippageBps. USDG = 1 USD.
    ///   buy  (amountIn = USDG base units):
    ///     tokens = (amountIn / 10^ud) / (p / 1e18)          whole tokens
    ///     raw    = tokens * 10^td = amountIn * 10^td * 1e18 / (p * 10^ud)
    ///     minOut = raw * (10000 - s) / 10000
    ///            = amountIn * (10^td * 1e18 * (10000 - s)) / (p * 10^ud * 10000)
    ///   sell (amountIn = Stock Token base units):
    ///     usd    = (amountIn / 10^td) * (p / 1e18)
    ///     raw    = usd * 10^ud = amountIn * p * 10^ud / (10^td * 1e18)
    ///     minOut = amountIn * (p * 10^ud * (10000 - s)) / (10^td * 1e18 * 10000)
    /// Computed with one full-precision mulDiv (512-bit intermediate), rounded down.
    function quoteMinOut(address stockToken, uint256 amountIn, bool isBuy, uint16 maxSlippageBps)
        public
        view
        returns (uint256 minOut, bool hold)
    {
        if (!registry.isCanonical(stockToken)) revert NotCanonical(stockToken);
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps);
        Valuer.Quote memory q = valuer.quote(stockToken);
        uint256 tokenUnit = 10 ** IERC20Metadata(stockToken).decimals();
        uint256 usdgUnit = 10 ** usdgDecimals;
        uint256 keep = BPS - maxSlippageBps;
        if (isBuy) {
            minOut = Math.mulDiv(amountIn, tokenUnit * 1e18 * keep, q.priceUsdPerToken * usdgUnit * BPS);
        } else {
            minOut = Math.mulDiv(amountIn, q.priceUsdPerToken * usdgUnit * keep, tokenUnit * 1e18 * BPS);
        }
        hold = q.hold;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory d = abi.decode(data, (SwapData));
        bool zeroForOne = d.tokenIn == d.key.currency0;

        int256 delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: zeroForOne ? V4Constants.MIN_SQRT_PRICE_LIMIT : V4Constants.MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());

        // Exact input must be consumed in full, or input would be stranded in the router.
        uint256 used = dIn < 0 ? uint256(int256(-dIn)) : 0;
        if (used != d.amountIn) revert PartialFill(d.amountIn, used);
        uint256 out = dOut > 0 ? uint256(int256(dOut)) : 0;
        if (out < d.minOut) revert Slippage(d.minOut, out);

        poolManager.sync(d.tokenIn);
        IERC20(d.tokenIn).safeTransfer(address(poolManager), d.amountIn);
        poolManager.settle();
        poolManager.take(d.tokenOut, d.recipient, out);
        return abi.encode(out);
    }

    function _checkedMinOut(address stockToken, uint256 amountIn, bool isBuy, uint16 bps, address recipient)
        private
        view
        returns (uint256 minOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        bool hold;
        (minOut, hold) = quoteMinOut(stockToken, amountIn, isBuy, bps);
        if (hold) revert MarketOnHold(stockToken);
        if (_pools[stockToken].currency0 == address(0) && _pools[stockToken].currency1 == address(0)) {
            revert NoPool(stockToken);
        }
    }

    function _swap(SwapData memory d) private returns (uint256 out) {
        out = abi.decode(poolManager.unlock(abi.encode(d)), (uint256));
    }
}
