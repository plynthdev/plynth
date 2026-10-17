// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHooks, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {StockTokenRegistry} from "../../src/core/StockTokenRegistry.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Audit privileged finding: feed and pool changes and keeper settings took effect instantly. Now a change that can
/// hurt users waits 48 h in public (ChangeDelay); first-time setup and risk-reducing changes still apply at once.
contract AdminDelaysTest is CrowdBuyBase {
    uint256 constant DELAY = 48 hours;

    function test_PRIV_replacingAPoolWaits48h() public {
        PoolKey memory cur = router.poolOf(address(tokA));
        PoolKey memory evil = PoolKey(cur.currency0, cur.currency1, 10_000, 200, IHooks(address(0)));
        vm.prank(owner);
        router.setPool(address(tokA), evil);
        assertEq(router.poolOf(address(tokA)).fee, cur.fee, "pool replaced instantly");
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(owner);
        vm.expectRevert();
        router.setPool(address(tokA), evil);
        vm.warp(block.timestamp + 1);
        vm.prank(owner);
        router.setPool(address(tokA), evil);
        assertEq(router.poolOf(address(tokA)).fee, 10_000);
    }

    function test_PRIV_changingAListedFeedWaits48hButListingAndDelistingDoNot() public {
        MockFeed evil = new MockFeed(8, 1e8, "evil");
        registry.list(address(tokA), address(evil), true);
        assertEq(registry.entry(address(tokA)).feed, address(feedA), "feed swapped instantly");
        vm.warp(block.timestamp + DELAY);
        registry.list(address(tokA), address(evil), true);
        assertEq(registry.entry(address(tokA)).feed, address(evil));
        // Delisting is risk-reducing: at once. Re-listing a delisted token waits again.
        registry.delist(address(tokB));
        assertFalse(registry.isCanonical(address(tokB)));
        registry.list(address(tokB), address(feedB), true);
        assertFalse(registry.isCanonical(address(tokB)));
        // A brand-new token lists at once.
        address fresh = makeAddr("fresh");
        registry.list(fresh, address(feedB), true);
        assertTrue(registry.isCanonical(fresh));
    }

    function test_PRIV_newKeepersWait48hRemovingIsInstant() public {
        address k2 = makeAddr("k2");
        vm.startPrank(owner);
        crowd.setKeeper(k2);
        vault.setKeeper(k2);
        beacon.setKeeper(k2);
        vm.stopPrank();
        assertEq(crowd.keeper(), keeper, "crowd keeper rotated instantly");
        assertEq(vault.keeper(), keeper, "vault keeper rotated instantly");
        assertEq(beacon.keeper(), keeper, "beacon keeper rotated instantly");
        vm.warp(block.timestamp + DELAY);
        vm.startPrank(owner);
        crowd.setKeeper(k2);
        vault.setKeeper(k2);
        beacon.setKeeper(k2);
        // Removing a keeper (zero) only switches a path off: at once.
        crowd.setKeeper(address(0));
        vault.setKeeper(address(0));
        vm.stopPrank();
        assertEq(beacon.keeper(), k2);
        assertEq(crowd.keeper(), address(0));
        assertEq(vault.keeper(), address(0));
    }

    function test_PRIV_ownerCanCancelAQueuedChange() public {
        address k2 = makeAddr("k2");
        vm.prank(owner);
        crowd.setKeeper(k2);
        bytes32 id = crowd.changeId(abi.encodeCall(crowd.setKeeper, (k2)));
        assertGt(crowd.changeEta(id), 0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        crowd.cancelChange(id);
        vm.prank(owner);
        crowd.cancelChange(id);
        assertEq(crowd.changeEta(id), 0);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        crowd.setKeeper(k2); // queues again, does not apply
        assertEq(crowd.keeper(), keeper);
        registry.list(address(tokA), address(feedB), true);
        bytes32 rid = registry.changeId(abi.encodeCall(registry.list, (address(tokA), address(feedB), true)));
        assertGt(registry.changeEta(rid), 0);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotOwner.selector));
        vm.prank(owner);
        registry.cancelChange(rid);
    }
}
