// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EligibilityRegistry} from "../src/core/EligibilityRegistry.sol";

/// ERC-1271 attester that accepts exactly one digest.
contract Wallet1271 {
    bytes32 public ok;

    function allow(bytes32 d) external {
        ok = d;
    }

    function isValidSignature(bytes32 d, bytes calldata) external view returns (bytes4) {
        return d == ok ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract EligibilityRegistryTest is Test {
    EligibilityRegistry reg;
    address owner = makeAddr("owner");
    uint256 attKey = 0xA77E57; // test-key
    address att;
    address user = makeAddr("user");
    uint64 constant T0 = 1_800_000_000;
    uint32 constant FLAGS = 7;

    function setUp() public {
        vm.warp(T0);
        att = vm.addr(attKey);
        reg = new EligibilityRegistry(owner, att);
    }

    function _sig(uint256 key, address u, uint64 issuedAt, uint64 expiry, uint32 flags) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, reg.attestationDigest(u, issuedAt, expiry, flags));
        return abi.encodePacked(r, s, v);
    }

    function _attest(uint64 issuedAt, uint64 expiry) internal {
        reg.attest(user, issuedAt, expiry, FLAGS, _sig(attKey, user, issuedAt, expiry, FLAGS));
    }

    // E1
    function test_E1_anyoneSubmitsValidAttestation() public {
        assertFalse(reg.isEligible(user));
        vm.prank(makeAddr("relayer"));
        _attest(T0, T0 + 30 days);
        assertTrue(reg.isEligible(user));
        EligibilityRegistry.Record memory r = reg.recordOf(user);
        assertEq(r.flags, FLAGS);
        assertEq(r.expiry, T0 + 30 days);
    }

    function test_E1_wrongSignerRejected() public {
        bytes memory sig = _sig(0xBAD, user, T0, T0 + 1 days, FLAGS); // test-key
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        reg.attest(user, T0, T0 + 1 days, FLAGS, sig);
    }

    function test_E1_tamperedFieldsRejected() public {
        bytes memory sig = _sig(attKey, user, T0, T0 + 1 days, FLAGS);
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        reg.attest(user, T0, T0 + 2 days, FLAGS, sig);
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        reg.attest(makeAddr("other"), T0, T0 + 1 days, FLAGS, sig);
    }

    function test_E1_erc1271Attester() public {
        Wallet1271 w = new Wallet1271();
        vm.prank(owner);
        reg.setAttester(address(w));
        w.allow(reg.attestationDigest(user, T0, T0 + 1 days, 1));
        reg.attest(user, T0, T0 + 1 days, 1, "");
        assertTrue(reg.isEligible(user));
    }

    // E2
    function test_E2_expiredAttestationNotEligible() public {
        _attest(T0, T0 + 30 days);
        vm.warp(T0 + 30 days - 1);
        assertTrue(reg.isEligible(user));
        vm.warp(T0 + 30 days);
        assertFalse(reg.isEligible(user));
    }

    function test_E2_windowChecks() public {
        bytes memory s1 = _sig(attKey, user, T0 + 1, T0 + 1 days, FLAGS);
        vm.expectRevert(EligibilityRegistry.BadWindow.selector); // issued in the future
        reg.attest(user, T0 + 1, T0 + 1 days, FLAGS, s1);
        bytes memory s2 = _sig(attKey, user, T0 - 10, T0, FLAGS);
        vm.expectRevert(EligibilityRegistry.BadWindow.selector); // already expired
        reg.attest(user, T0 - 10, T0, FLAGS, s2);
        bytes memory s3 = _sig(attKey, user, T0, T0 + 32 days, FLAGS);
        vm.expectRevert(EligibilityRegistry.BadWindow.selector); // longer than MAX_TTL
        reg.attest(user, T0, T0 + 32 days, FLAGS, s3);
    }

    function testFuzz_E2_eligibleExactlyInsideWindow(uint64 ttl, uint64 dt) public {
        ttl = uint64(bound(ttl, 1, reg.MAX_TTL()));
        _attest(T0, T0 + ttl);
        dt = uint64(bound(dt, 0, 2 * uint256(reg.MAX_TTL())));
        vm.warp(T0 + dt);
        assertEq(reg.isEligible(user), dt < ttl);
    }

    // E3
    function test_E3_oldSignatureCannotUndoRevoke() public {
        bytes memory sig = _sig(attKey, user, T0, T0 + 30 days, FLAGS);
        reg.attest(user, T0, T0 + 30 days, FLAGS, sig);
        vm.warp(T0 + 1 hours);
        vm.prank(att);
        reg.revoke(user);
        assertFalse(reg.isEligible(user));
        vm.expectRevert(EligibilityRegistry.Stale.selector);
        reg.attest(user, T0, T0 + 30 days, FLAGS, sig);
        // a fresh attestation issued after the revoke restores eligibility
        vm.warp(T0 + 2 hours);
        _attest(T0 + 2 hours, T0 + 2 hours + 1 days);
        assertTrue(reg.isEligible(user));
    }

    function test_E3_cannotReplaceWithOlderOrSameIssuedAt() public {
        vm.warp(T0 + 1 days);
        _attest(T0 + 1 days, T0 + 20 days);
        bytes memory older = _sig(attKey, user, T0, T0 + 2 days, FLAGS);
        vm.expectRevert(EligibilityRegistry.Stale.selector);
        reg.attest(user, T0, T0 + 2 days, FLAGS, older);
        bytes memory same = _sig(attKey, user, T0 + 1 days, T0 + 3 days, FLAGS);
        vm.expectRevert(EligibilityRegistry.Stale.selector);
        reg.attest(user, T0 + 1 days, T0 + 3 days, FLAGS, same);
    }

    // E4
    function test_E4_onlyAttesterRevokes() public {
        _attest(T0, T0 + 1 days);
        vm.expectRevert(EligibilityRegistry.NotAttester.selector);
        vm.prank(owner);
        reg.revoke(user);
        vm.prank(att);
        reg.revoke(user);
        assertFalse(reg.isEligible(user));
        assertEq(reg.revokedAt(user), T0);
    }

    function test_E4_attesterRotation() public {
        uint256 newKey = 0xB0B; // test-key
        address newAtt = vm.addr(newKey);
        bytes memory oldSig = _sig(attKey, user, T0, T0 + 1 days, FLAGS);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, att));
        vm.prank(att);
        reg.setAttester(newAtt);

        vm.prank(owner);
        reg.setAttester(newAtt);
        assertEq(reg.attester(), newAtt);

        // the old attester's unsubmitted signature is dead, the new one works
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        reg.attest(user, T0, T0 + 1 days, FLAGS, oldSig);
        reg.attest(user, T0, T0 + 1 days, FLAGS, _sig(newKey, user, T0, T0 + 1 days, FLAGS));
        assertTrue(reg.isEligible(user));

        // the old attester can no longer revoke; the new one can
        vm.expectRevert(EligibilityRegistry.NotAttester.selector);
        vm.prank(att);
        reg.revoke(user);
        vm.prank(newAtt);
        reg.revoke(user);
        assertFalse(reg.isEligible(user));
    }

    function test_E4_zeroAttesterRejected() public {
        vm.expectRevert(EligibilityRegistry.ZeroAddress.selector);
        vm.prank(owner);
        reg.setAttester(address(0));
        vm.expectRevert(EligibilityRegistry.ZeroAddress.selector);
        new EligibilityRegistry(owner, address(0));
    }

    /// Off-chain signers (viem) must reproduce this digest: pin the type string.
    function test_typehashMatchesServiceTypes() public view {
        assertEq(
            reg.ATTESTATION_TYPEHASH(), keccak256("Attestation(address user,uint64 issuedAt,uint64 expiry,uint32 flags)")
        );
    }
}
