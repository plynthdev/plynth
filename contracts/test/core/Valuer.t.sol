// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

contract ValuerTest is Test {
    StockTokenRegistry reg;
    Valuer valuer;
    MockFeed feed;
    MockStockToken tok;
    address board = makeAddr("board");

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new StockTokenRegistry(board);
        valuer = new Valuer(reg, 30 minutes);
        feed = new MockFeed(8, 250e8, "mock"); // $250, 8 decimals like Chainlink equity feeds
        tok = new MockStockToken("Mock", "MOCK");
        vm.prank(board);
        reg.list(address(tok), address(feed), false);
    }

    function test_quoteAppliesMultiplierOnce() public {
        tok.setUiMultiplier(1.5e18);
        Valuer.Quote memory q = valuer.quote(address(tok));
        assertEq(q.priceUsdPerToken, 375e18);
        assertFalse(q.hold);
    }

    function test_embeddedFeedNeverDoubleApplies() public {
        vm.prank(board);
        reg.list(address(tok), address(feed), true); // a listed token's feed/flag change waits 48 h (ChangeDelay)
        vm.warp(block.timestamp + 48 hours); // ChangeDelay
        vm.prank(board);
        reg.list(address(tok), address(feed), true);
        vm.warp(block.timestamp - 48 hours);
        tok.setUiMultiplier(1.5e18);
        assertEq(valuer.quote(address(tok)).priceUsdPerToken, 250e18);
    }

    function test_value() public {
        tok.setUiMultiplier(2e18);
        (uint256 usd, bool hold) = valuer.value(address(tok), 3e18);
        assertEq(usd, 1500e18);
        assertFalse(hold);
    }

    function test_staleFeedHoldsInsteadOfReverting() public {
        feed.set(250e8);
        feed.setUpdatedAt(block.timestamp - 31 minutes);
        assertTrue(valuer.quote(address(tok)).hold);
        feed.set(250e8);
        feed.setUpdatedAt(block.timestamp - 30 minutes);
        assertFalse(valuer.quote(address(tok)).hold);
    }

    function test_nonCanonicalReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Valuer.NotCanonical.selector, address(0xBEEF)));
        valuer.quote(address(0xBEEF));
    }

    function test_delistedReverts() public {
        vm.prank(board);
        reg.delist(address(tok));
        assertFalse(reg.isCanonical(address(tok)));
        vm.expectRevert(abi.encodeWithSelector(Valuer.NotCanonical.selector, address(tok)));
        valuer.quote(address(tok));
    }

    function test_nonPositiveAnswerReverts() public {
        feed.set(0);
        feed.setUpdatedAt(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(Valuer.BadAnswer.selector, address(tok), int256(0)));
        valuer.quote(address(tok));
    }

    function test_onlyBoardLists() public {
        vm.expectRevert(StockTokenRegistry.NotOwner.selector);
        reg.list(address(tok), address(feed), false);
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(board);
        reg.transferOwnership(next);
        assertEq(reg.owner(), board);
        vm.prank(next);
        reg.acceptOwnership();
        assertEq(reg.owner(), next);
    }

    function testFuzz_valueMatchesFormula(uint64 price, uint64 mult, uint96 units) public {
        vm.assume(price > 0 && mult > 0);
        feed.set(int256(uint256(price)));
        feed.setUpdatedAt(block.timestamp);
        tok.setUiMultiplier(mult);
        (uint256 usd,) = valuer.value(address(tok), units);
        uint256 p = uint256(price) * 1e10 * mult / 1e18;
        assertEq(usd, uint256(units) * p / 1e18);
    }
}
