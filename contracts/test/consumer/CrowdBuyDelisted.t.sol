// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Audit L-2: a token delisted after a saver set their mix kept receiving that share of every join, feeding a book
/// that can never execute (the Valuer refuses a non-canonical token) until the saver noticed and cancelled.
contract CrowdBuyDelistedTest is CrowdBuyBase {
    function _halfHalf(address u, uint256 amount) internal {
        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        (t[0], t[1], w[0], w[1]) = (address(tokA), address(tokB), 5000, 5000);
        _prepare(u, t, w, amount);
    }

    function test_L2_delistedMixEntryGetsNothing() public {
        address u = _user(0);
        _halfHalf(u, 10 * U);
        registry.delist(address(tokB));
        vm.prank(u);
        crowd.join(u);
        assertEq(crowd.orderOf(address(tokB), 0, u), 0, "USDG fed a delisted token's book");
        assertEq(crowd.orderOf(address(tokA), 0, u), 10 * U);
    }

    function test_L2_allDelistedRevertsAndKeepsPending() public {
        address u = _user(0);
        _halfHalf(u, 10 * U);
        registry.delist(address(tokA));
        registry.delist(address(tokB));
        vm.expectRevert();
        vm.prank(u);
        crowd.join(u);
        (, uint256 pending) = vault.balancesOf(u);
        assertEq(pending, 10 * U);
    }
}
