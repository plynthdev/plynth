// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {StockRouter} from "../../core/StockRouter.sol";
import {Valuer} from "../../core/Valuer.sol";
import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {PolicyGuard} from "../PolicyGuard.sol";
import {AssetValuation} from "../AssetValuation.sol";
import {ISleeve} from "../interfaces/ISleeve.sol";
import {ITreasuryAccount} from "../interfaces/ITreasuryAccount.sol";

/// What the sleeve reads from its caller besides ITreasuryAccount: the guard whose loss bound caps slippage.
interface IGuardedAccount {
    function guard() external view returns (PolicyGuard);
}

/// Equity band adapter: buys and sells a fixed list of Stock Tokens for USDG through the StockRouter.
///
/// - Slippage is bounded by policy: a desk may ask for at most the guard's `maxOpLossBps` (and the router's
///   own 5% ceiling), measured against the oracle, never against the pool.
/// - After a buy, the account may hold at most `perNameFloatCapBps` of the token's `totalSupply()`. Sells are
///   never blocked by the cap, so an account that drifted over it can always reduce.
/// - Holdings are raw base units; value = raw x Valuer price (multiplier applied once, inside the Valuer).
///
/// Stateless like every adapter: input is pulled from the caller, output goes straight back to it.
contract EquitySleeve is ISleeve {
    using SafeERC20 for IERC20;

    uint8 public constant OP_BUY = 0; // amount = USDG in
    uint8 public constant OP_SELL = 1; // amount = Stock Token raw in
    uint256 public constant MAX_TOKENS = 16;
    uint256 private constant BPS = 10_000;

    StockRouter public immutable router;
    Valuer public immutable valuer;
    IERC20 public immutable usdg;

    address[] private _tokens;
    uint8[] private _kinds;
    mapping(address token => bool) public isToken;

    error ZeroAddress();
    error TooManyTokens();
    error DuplicateToken(address token);
    error UnknownToken(address token);
    error UnknownOp(uint8 op);
    error ZeroAmount();
    error SlippageAbovePolicy(uint16 asked, uint16 allowed);
    error FloatCapExceeded(address token, uint256 held, uint256 cap);
    error Residual(address token);

    constructor(StockRouter router_, address[] memory tokens) {
        if (address(router_) == address(0)) revert ZeroAddress();
        if (tokens.length > MAX_TOKENS) revert TooManyTokens();
        router = router_;
        valuer = router_.valuer();
        usdg = IERC20(address(router_.usdg()));
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(0) || t == address(usdg)) revert ZeroAddress();
            if (isToken[t]) revert DuplicateToken(t);
            isToken[t] = true;
            _tokens.push(t);
            _kinds.push(AssetValuation.KIND_STOCK_TOKEN);
        }
    }

    function band() external pure returns (uint8) {
        return 1;
    }

    function assets() external view returns (address[] memory, uint8[] memory) {
        return (_tokens, _kinds);
    }

    /// Per-token raw holdings of `account`, in assets() order.
    function holdings(address account) external view returns (address[] memory tokens, uint256[] memory raw) {
        tokens = _tokens;
        raw = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) raw[i] = IERC20(tokens[i]).balanceOf(account);
    }

    /// Most raw units of `token` an account under `floatCapBps` may hold right now.
    function floatCapRaw(address token, uint16 floatCapBps) public view returns (uint256) {
        return IERC20(token).totalSupply() * floatCapBps / BPS;
    }

    /// Sum of raw x Valuer price over the listed tokens (USD 1e18); `hold` if any held token's feed is stale.
    function valueOf(address account) external view returns (uint256 usd, bool hold) {
        for (uint256 i; i < _tokens.length; ++i) {
            (uint256 v, bool h) =
                AssetValuation.value(valuer, _tokens[i], _kinds[i], IERC20(_tokens[i]).balanceOf(account));
            usd += v;
            hold = hold || h;
        }
    }

    /// data = abi.encode(uint8 op, address token, uint256 amount, uint16 slippageBps). Returns abi.encode(out).
    /// The caller must be a TreasuryAccount (its policy and guard are read).
    function run(bytes calldata data) external returns (bytes memory) {
        (uint8 op, address token, uint256 amount, uint16 slippageBps) =
            abi.decode(data, (uint8, address, uint256, uint16));
        if (!isToken[token]) revert UnknownToken(token);
        if (amount == 0) revert ZeroAmount();
        uint16 allowed = IGuardedAccount(msg.sender).guard().maxOpLossBps();
        if (slippageBps > allowed) revert SlippageAbovePolicy(slippageBps, allowed);

        uint256 usdg0 = usdg.balanceOf(address(this));
        uint256 token0 = IERC20(token).balanceOf(address(this));
        uint256 out;
        if (op == OP_BUY) {
            usdg.safeTransferFrom(msg.sender, address(this), amount);
            usdg.forceApprove(address(router), amount);
            out = router.buy(token, amount, slippageBps, msg.sender);
            usdg.forceApprove(address(router), 0);
            (TreasuryPolicy.Policy memory p,,) = ITreasuryAccount(msg.sender).policy().current();
            uint256 held = IERC20(token).balanceOf(msg.sender);
            uint256 cap = floatCapRaw(token, p.perNameFloatCapBps);
            if (held > cap) revert FloatCapExceeded(token, held, cap);
        } else if (op == OP_SELL) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            IERC20(token).forceApprove(address(router), amount);
            out = router.sell(token, amount, slippageBps, msg.sender);
            IERC20(token).forceApprove(address(router), 0);
        } else {
            revert UnknownOp(op);
        }
        // The router pulls exactly `amount` or reverts; anything left here would be stranded. Compared with
        // the balance before the call, so a donation to the adapter cannot block it.
        if (usdg.balanceOf(address(this)) != usdg0) revert Residual(address(usdg));
        if (IERC20(token).balanceOf(address(this)) != token0) revert Residual(token);
        return abi.encode(out);
    }
}
