// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {StockTokenRegistry} from "./StockTokenRegistry.sol";

/// Values canonical Stock Tokens in USD (1e18) from Chainlink x ERC-8056 multiplier.
/// A stale feed (off-hours or outage) does not revert: it returns hold = true so callers allow only risk-reducing actions.
contract Valuer {
    struct Quote {
        uint256 priceUsdPerToken; // 1e18, multiplier applied exactly once
        uint256 multiplier; // 1e18
        uint80 roundId;
        uint256 updatedAt;
        bool hold;
    }

    StockTokenRegistry public immutable registry;
    uint256 public immutable maxStaleness;

    error NotCanonical(address token);
    error BadAnswer(address token, int256 answer);

    constructor(StockTokenRegistry registry_, uint256 maxStaleness_) {
        registry = registry_;
        maxStaleness = maxStaleness_;
    }

    function quote(address token) public view returns (Quote memory q) {
        StockTokenRegistry.Entry memory e = registry.entry(token);
        if (!e.active) revert NotCanonical(token);

        AggregatorV3Interface feed = AggregatorV3Interface(e.feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadAnswer(token, answer);

        uint256 price = _to1e18(uint256(answer), feed.decimals());
        q.multiplier = IStockToken(token).uiMultiplier();
        q.priceUsdPerToken = e.multiplierEmbedded ? price : price * q.multiplier / 1e18;
        q.roundId = roundId;
        q.updatedAt = updatedAt;
        q.hold = updatedAt + maxStaleness < block.timestamp;
    }

    /// USD value (1e18) of `rawUnits` of `token` held in base units.
    function value(address token, uint256 rawUnits) external view returns (uint256 usd, bool hold) {
        Quote memory q = quote(token);
        uint8 dec = IStockToken(token).decimals();
        usd = rawUnits * q.priceUsdPerToken / (10 ** dec);
        hold = q.hold;
    }

    function _to1e18(uint256 x, uint8 dec) private pure returns (uint256) {
        if (dec == 18) return x;
        if (dec < 18) return x * 10 ** (18 - dec);
        return x / 10 ** (dec - 18);
    }
}
