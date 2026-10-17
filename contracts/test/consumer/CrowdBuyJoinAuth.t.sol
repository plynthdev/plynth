// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Audit L-3: join(user) was permissionless, so a stranger could front-run a saver's withdraw of pending USDG by
/// sweeping it into a book order (the saver then has to cancel the order to get it back).
contract CrowdBuyJoinAuthTest is CrowdBuyBase {
    function test_L3_strangerCannotJoinForASaver() public {
        address u = _user(0);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(u, a, w, 10 * U);
        vm.prank(makeAddr("stranger"));
        (bool ok,) = address(crowd).call(abi.encodeWithSignature("join(address)", u));
        assertFalse(ok, "a stranger swept the saver's pending USDG into a book");
        // The saver's withdraw is untouched.
        vm.prank(u);
        vault.withdraw(10 * U, u);
        assertEq(usdg.balanceOf(u), 10 * U);
    }

    function test_L3_userAndKeeperMayJoin() public {
        address u = _user(0);
        address v = _user(1);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(u, a, w, 10 * U);
        _prepare(v, a, w, 20 * U);
        vm.prank(u);
        crowd.join(u);
        vm.prank(keeper);
        crowd.join(v);
        assertEq(crowd.orderOf(address(tokA), 0, u), 10 * U);
        assertEq(crowd.orderOf(address(tokA), 0, v), 20 * U);
    }

    /// The keeper's batch skips savers that cannot join (nothing pending, no mix, all delisted) instead of reverting.
    function test_L3_joinBatchSkipsWhoCannotJoin() public {
        address u = _user(0);
        address idle = _user(1); // no pending
        address v = _user(2);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(u, a, w, 10 * U);
        (address[] memory b, uint16[] memory wb) = _one(address(tokB));
        _prepare(v, b, wb, 5 * U);
        registry.delist(address(tokB)); // v's only token is gone: skipped, pending kept
        address[] memory users = new address[](3);
        (users[0], users[1], users[2]) = (u, idle, v);
        vm.prank(keeper);
        uint256 joined = crowd.joinBatch(users);
        assertEq(joined, 1);
        assertEq(crowd.orderOf(address(tokA), 0, u), 10 * U);
        (, uint256 pendingV) = vault.balancesOf(v);
        assertEq(pendingV, 5 * U);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        crowd.joinBatch(users);
    }
}
