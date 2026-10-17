// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";

/// Audit lead: split timing relies on multiplierEmbedded. Robinhood Chain has had no split to fork across yet (the
/// live uiMultipliers on 2026-10-16 are 1.0 or small dividend adjustments, e.g. SPY 1.0017, and the public RPC keeps
/// no historical state), so this pins the behaviour on a mainnet fork for all 14 v2 stocks with a simulated split:
/// every feed prices ONE token (multiplier embedded), and a multiplier change at the token (a 2:1 split, or a reverse
/// 1:10) that lands before the feed reacts does not move the Valuer price at all. Skipped without RHC_MAINNET_RPC_URL.
contract StockSplitForkTest is Test {
    MainnetBeta script;
    StockTokenRegistry reg;
    Valuer valuer;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        script = new MainnetBeta();
        reg = new StockTokenRegistry(address(this));
        valuer = new Valuer(reg, 7 days);
        MainnetBeta.Stock[] memory s = script.stocks();
        for (uint256 i; i < s.length; ++i) {
            reg.list(s[i].token, s[i].feed, true);
        }
    }

    function test_fork_everyFeedPricesOneTokenAndASplitDoesNotMoveIt() public {
        MainnetBeta.Stock[] memory s = script.stocks();
        assertEq(s.length, 14);
        for (uint256 i; i < s.length; ++i) {
            (, int256 answer,,,) = AggregatorV3Interface(s[i].feed).latestRoundData();
            uint8 dec = AggregatorV3Interface(s[i].feed).decimals();
            uint256 feedPrice = uint256(answer) * 10 ** (18 - dec);
            Valuer.Quote memory before = valuer.quote(s[i].token);
            assertEq(before.priceUsdPerToken, feedPrice, s[i].sym);
            uint256 m = IStockToken(s[i].token).uiMultiplier();
            for (uint256 k; k < 2; ++k) {
                uint256 split = k == 0 ? m * 2 : m / 10; // 2:1 split, 1:10 reverse split
                vm.mockCall(s[i].token, abi.encodeWithSelector(IStockToken.uiMultiplier.selector), abi.encode(split));
                Valuer.Quote memory q = valuer.quote(s[i].token);
                assertEq(q.priceUsdPerToken, before.priceUsdPerToken, s[i].sym);
                assertEq(q.multiplier, split);
                (uint256 usd,) = valuer.value(s[i].token, 10 ** IStockToken(s[i].token).decimals());
                assertEq(usd, before.priceUsdPerToken, s[i].sym);
                vm.clearMockedCalls();
            }
        }
    }
}
