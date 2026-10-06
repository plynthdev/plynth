// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// Eligibility gates buying only (setMix, CrowdBuy.join). Every exit stays open for a revoked or expired user.
contract EligibilityGateTest is CrowdBuyBase {
    bytes32 constant SECRET = keccak256("s");
    uint256 constant ATT_KEY = 0xA77E57; // test-key
    EligibilityRegistry reg;
    address att;

    function setUp() public override {
        super.setUp();
        att = vm.addr(ATT_KEY);
        reg = new EligibilityRegistry(owner, att);
        vm.prank(owner);
        vault.setEligibility(IEligibility(address(reg)));
    }

    function _attest(address user, uint64 ttl) internal {
        uint64 t = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATT_KEY, reg.attestationDigest(user, t, t + ttl, 7));
        reg.attest(user, t, t + ttl, 7, abi.encodePacked(r, s, v));
    }

    function _mixA() internal view returns (SavingsVault.MixEntry[] memory m) {
        m = new SavingsVault.MixEntry[](1);
        m[0] = SavingsVault.MixEntry(address(tokA), 10_000);
    }

    function test_setOnce_ownerOnly() public {
        vm.expectRevert(SavingsVault.EligibilityAlreadySet.selector);
        vm.prank(owner);
        vault.setEligibility(IEligibility(address(reg)));
    }

    function test_setEligibility_onlyOwner_nonZero() public {
        SavingsVault v2 = new SavingsVault(usdg, address(0xdead), ICanonicalRegistry(address(registry)), owner, keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        v2.setEligibility(IEligibility(address(reg)));
        vm.expectRevert(SavingsVault.ZeroAddress.selector);
        vm.prank(owner);
        v2.setEligibility(IEligibility(address(0)));
        assertTrue(v2.canBuy(keeper), "no registry yet -> ungated");
    }

    function test_setMixRequiresEligibility() public {
        address u = _user(0);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.NotEligible.selector, u));
        vm.prank(u);
        vault.setMix(_mixA());
        _attest(u, 30 days);
        vm.prank(u);
        vault.setMix(_mixA());
        assertEq(vault.mixOf(u).length, 1);
    }

    function test_joinRequiresEligibility_expiredRevertsExitWorks() public {
        address u = _user(0);
        _attest(u, 1 days);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(u, a, w, 40 * U);
        vm.warp(block.timestamp + 1 days); // attestation expired
        assertFalse(reg.isEligible(u));
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.NotEligible.selector, u));
        crowd.join(u);
        // exit: the whole balance (pending) is withdrawable
        vm.prank(u);
        vault.withdraw(40 * U, u);
        assertEq(usdg.balanceOf(u), 40 * U);
    }

    function test_revokedUserCanExitEverything() public {
        address[] memory users = new address[](3);
        for (uint256 i; i < 3; ++i) {
            users[i] = _user(i);
            _attest(users[i], 30 days);
            _joinA(users[i], (i + 1) * 10 * U);
        }
        address u = users[0];
        // u also keeps a vault balance and a second, unexecuted order (book 1 after execution)
        usdg.mint(u, 5 * U);
        vm.startPrank(u);
        usdg.approve(address(vault), 5 * U);
        vault.deposit(5 * U);
        vm.stopPrank();

        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS);
        uint64 at = _reveal(address(tokA), 0, SECRET);
        vm.warp(at);
        _freshFeeds();
        _executeAsKeeper(address(tokA));

        // u joins the next book while still eligible, then is revoked
        _accrue(u, 7 * U);
        crowd.join(u);
        vm.prank(att);
        reg.revoke(u);
        assertFalse(reg.isEligible(u));

        // buying is blocked
        _accrue(u, 3 * U);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.NotEligible.selector, u));
        crowd.join(u);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.NotEligible.selector, u));
        vm.prank(u);
        vault.setMix(_mixA());

        // every exit works: claim the executed allocation, cancel the open order, withdraw everything
        uint256 alloc = crowd.allocationOf(address(tokA), 0, u);
        assertGt(alloc, 0);
        vm.startPrank(u);
        crowd.claimOpen(address(tokA), 0);
        assertEq(tokA.balanceOf(u), alloc);
        crowd.cancel(address(tokA), 1);
        (uint256 avail, uint256 pend) = vault.balancesOf(u);
        vault.withdraw(avail + pend, u);
        vm.stopPrank();
        assertEq(avail + pend, 5 * U + 7 * U + 3 * U);
        assertEq(usdg.balanceOf(u), 15 * U);
        (avail, pend) = vault.balancesOf(u);
        assertEq(avail + pend, 0);
    }
}
