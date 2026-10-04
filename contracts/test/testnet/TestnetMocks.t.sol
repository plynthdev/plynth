// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";

contract MockUSDGTest is Test {
    MockUSDG usdg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdg = new MockUSDG();
        usdg.mint(alice, 1_000e6);
    }

    function test_metadataIsMockUsdgWithSixDecimals() public view {
        assertEq(usdg.name(), "Mock USDG");
        assertEq(usdg.decimals(), 6);
        assertEq(usdg.balanceOf(alice), 1_000e6);
    }

    function test_onlyOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        usdg.mint(alice, 1);
    }

    function test_onlyOwnerFreezesAndUnfreezes() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        usdg.freeze(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        usdg.unfreeze(bob);
        vm.stopPrank();
    }

    function test_frozenSenderCannotTransfer() public {
        usdg.freeze(alice);
        assertTrue(usdg.frozen(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, alice));
        usdg.transfer(bob, 1e6);
    }

    function test_frozenRecipientCannotReceive() public {
        usdg.freeze(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, bob));
        usdg.transfer(bob, 1e6);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, bob));
        usdg.mint(bob, 1e6);
    }

    function test_frozenSpenderPathBlockedViaTransferFrom() public {
        vm.prank(alice);
        usdg.approve(bob, 1e6);
        usdg.freeze(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, alice));
        usdg.transferFrom(alice, bob, 1e6);
    }

    function test_unfreezeRestoresTransfers() public {
        vm.expectEmit(true, false, false, false);
        emit MockUSDG.Frozen(alice);
        usdg.freeze(alice);
        vm.expectEmit(true, false, false, false);
        emit MockUSDG.Unfrozen(alice);
        usdg.unfreeze(alice);
        vm.prank(alice);
        usdg.transfer(bob, 1e6);
        assertEq(usdg.balanceOf(bob), 1e6);
    }

    function testFuzz_transfersConserveSupplyUnlessFrozen(uint256 amount, bool freezeBob) public {
        amount = bound(amount, 0, 1_000e6);
        if (freezeBob) usdg.freeze(bob);
        uint256 supply = usdg.totalSupply();
        vm.prank(alice);
        if (freezeBob) vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, bob));
        usdg.transfer(bob, amount);
        assertEq(usdg.totalSupply(), supply);
        assertEq(usdg.balanceOf(alice) + usdg.balanceOf(bob), 1_000e6);
        assertEq(usdg.balanceOf(bob), freezeBob ? 0 : amount);
    }
}

contract MockStockTokenTest is Test {
    MockStockToken tok;
    address alice = makeAddr("alice");

    function setUp() public {
        tok = new MockStockToken("Mock Apple", "mAAPL");
    }

    function test_eighteenDecimalsAndUnitMultiplierByDefault() public view {
        assertEq(tok.decimals(), 18);
        assertEq(tok.uiMultiplier(), 1e18);
        assertEq(tok.symbol(), "mAAPL");
    }

    function test_ownerSetsMultiplierAndEventCarriesOldAndNew() public {
        vm.expectEmit(false, false, false, true);
        emit MockStockToken.UIMultiplierUpdated(1e18, 1.0005e18);
        tok.setUiMultiplier(1.0005e18);
        assertEq(tok.uiMultiplier(), 1.0005e18);
        vm.expectEmit(false, false, false, true);
        emit MockStockToken.UIMultiplierUpdated(1.0005e18, 2e18);
        tok.setUiMultiplier(2e18);
    }

    function test_nonOwnerCannotSetMultiplierOrMint() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tok.setUiMultiplier(2e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tok.mint(alice, 1);
        vm.stopPrank();
    }

    function test_zeroMultiplierRejected() public {
        vm.expectRevert(MockStockToken.ZeroMultiplier.selector);
        tok.setUiMultiplier(0);
    }

    function testFuzz_multiplierDoesNotChangeRawBalances(uint256 mult, uint256 amount) public {
        mult = bound(mult, 1, 1e30);
        amount = bound(amount, 0, 1e30);
        tok.mint(alice, amount);
        tok.setUiMultiplier(mult);
        assertEq(tok.balanceOf(alice), amount);
        assertEq(tok.uiMultiplier(), mult);
    }
}

contract MockFeedTest is Test {
    MockFeed feed;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockFeed(8, 230e8, "mAAPL / USD");
    }

    function test_chainlinkShapeWithEightDecimals() public view {
        assertEq(feed.decimals(), 8);
        (uint80 id, int256 a, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = feed.latestRoundData();
        assertEq(id, 1);
        assertEq(a, 230e8);
        assertEq(startedAt, 1_000_000);
        assertEq(updatedAt, 1_000_000);
        assertEq(answeredIn, 1);
        assertEq(feed.latestAnswer(), 230e8);
    }

    function test_setStartsNewRoundAndKeepsHistory() public {
        vm.warp(1_000_100);
        feed.set(231e8);
        (uint80 id, int256 a,, uint256 t,) = feed.latestRoundData();
        assertEq(id, 2);
        assertEq(a, 231e8);
        assertEq(t, 1_000_100);
        (uint80 id1, int256 a1,, uint256 t1,) = feed.getRoundData(1);
        assertEq(id1, 1);
        assertEq(a1, 230e8);
        assertEq(t1, 1_000_000);
    }

    function test_setUpdatedAtMakesFeedStale() public {
        feed.setUpdatedAt(1);
        (,,, uint256 t,) = feed.latestRoundData();
        assertEq(t, 1);
    }

    function test_getRoundDataRevertsOnUnknownRound() public {
        vm.expectRevert(abi.encodeWithSelector(MockFeed.NoRound.selector, uint80(0)));
        feed.getRoundData(0);
        vm.expectRevert(abi.encodeWithSelector(MockFeed.NoRound.selector, uint80(2)));
        feed.getRoundData(2);
    }

    function test_onlyOwnerSets() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        feed.set(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        feed.setUpdatedAt(1);
        vm.stopPrank();
    }
}
