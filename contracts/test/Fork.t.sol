// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {StockTokenRegistry} from "../src/core/StockTokenRegistry.sol";
import {Valuer} from "../src/core/Valuer.sol";
import {MockFeed} from "./mocks/Mocks.sol";

/// Runs against a fork of Robinhood Chain mainnet (4663). Skipped when RHC_MAINNET_RPC_URL is unset.
contract ForkTest is Test {
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);
    }

    function test_realStockTokensExposeMultiplier() public view {
        assertEq(IStockToken(TSLA).decimals(), 18);
        assertGe(IStockToken(TSLA).uiMultiplier(), 1e18);
        assertGt(IStockToken(AAPL).uiMultiplier(), 1e18);
    }

    function test_valuerPricesRealTokenWithItsLiveMultiplier() public {
        StockTokenRegistry reg = new StockTokenRegistry(address(this));
        Valuer valuer = new Valuer(reg, 30 minutes);
        MockFeed feed = new MockFeed(8, 200e8); // per-share mock feed: exercises the multiplierEmbedded = false path
        reg.list(AAPL, address(feed), false);
        uint256 m = IStockToken(AAPL).uiMultiplier();
        assertEq(valuer.quote(AAPL).priceUsdPerToken, 200e18 * m / 1e18);
    }
}
