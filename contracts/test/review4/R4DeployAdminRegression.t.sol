// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MainnetBetaTest} from "../script/MainnetBeta.t.sol";
import {MainnetBeta} from "../../script/MainnetBeta.s.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {EligibilityRegistry} from "../../src/core/EligibilityRegistry.sol";
import {MockSafe} from "../mocks/MockSafe.sol";

/// A one-key "multisig" (the R4-ORC-1 PoC's OneOfOneSafe): Safe-shaped, threshold 1.
contract OneOfOneSafe {
    address public immutable key;

    constructor(address k) {
        key = k;
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }

    function getOwners() external view returns (address[] memory o) {
        o = new address[](1);
        o[0] = key;
    }
}

/// Answers getThreshold() with 2 but getOwners() with garbage (not an ABI-encoded array).
contract MalformedSafe {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return hex"01";
    }
}

/// Review v4 (2026-10-17) deploy / admin PoCs (wt-review4 R4DeployOwnerPin.t.sol; carried r3orig R3DeployAdmin.t.sol
/// R3-ORC-3 and R3-ORC-5), turned into regression tests that assert the safe behaviour.
contract R4DeployAdminRegressionTest is MainnetBetaTest {
    function _writeJson(string memory json) internal returns (string memory f, string memory path) {
        f = string.concat("r4-", vm.toString(uint256(uint32(msg.sig))), ".json");
        path = string.concat(vm.projectRoot(), "/../app/deployments/", f);
        vm.writeFile(path, json);
    }

    function _safe(uint256 owners, uint256 threshold) internal returns (address) {
        address[] memory o = new address[](owners);
        for (uint256 i; i < owners; i++) o[i] = makeAddr(string(abi.encode("signer", i)));
        return address(new MockSafe(o, threshold));
    }

    /// R4-ORC-1: a 1-of-1 Safe (or any one-key contract) fails the mainnet OWNER pin; a 2-of-3 Safe passes.
    function test_R4ORC1_oneOfOneSafeFailsTheOwnerPin() public {
        (address key,) = makeAddrAndKey("single-key");
        OneOfOneSafe o = new OneOfOneSafe(key);
        assertFalse(script.isMultisigOwner(address(o)));
        MainnetBeta.Config memory c = _cfg();
        c.owner = address(o);
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.OwnerNotMultisig.selector, address(o)));
        script.checkConfig(c, makeAddr("deployer"));
        c.owner = _safe(3, 2);
        script.checkConfig(c, makeAddr("deployer"));
        c.allowEoaOwner = true; // the explicit escape still works for a single key
        c.owner = address(o);
        script.checkConfig(c, makeAddr("deployer"));
    }

    function test_R4ORC1_nonSafeShapesFail() public {
        assertFalse(script.isMultisigOwner(_safe(1, 1)), "1-of-1");
        assertFalse(script.isMultisigOwner(_safe(2, 3)), "threshold above the owner count");
        assertTrue(script.isMultisigOwner(_safe(2, 2)), "2-of-2");
        assertFalse(script.isMultisigOwner(address(new MalformedSafe())), "malformed getOwners");
        address plain = makeAddr("plain-contract");
        vm.etch(plain, hex"00");
        assertFalse(script.isMultisigOwner(plain), "code that is not Safe-shaped");
        assertFalse(script.isMultisigOwner(makeAddr("eoa")), "no code");
    }

    /// The full mainnet deploy runs its handoff check against the OWNER pin too (the test OWNER is a 2-of-3).
    function test_R4ORC1_handoffAssertsTheMultisig() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        (string memory f, string memory path) = _writeJson(json);
        new MainnetBeta().verifyDeploymentStrict(f);
        vm.etch(owner, address(new OneOfOneSafe(makeAddr("k"))).code); // OWNER later turns into a one-key contract
        MainnetBeta v = new MainnetBeta();
        vm.expectRevert(abi.encodeWithSelector(MainnetBeta.HandoffIncomplete.selector, owner, "OWNER is a multisig (Safe, threshold >= 2)"));
        v.verifyDeploymentStrict(f);
        vm.removeFile(path);
    }

    /// R3-ORC-3: OWNER extending the holiday table (the remedy the 90-day alert asks for) keeps the strict check green.
    function test_R3ORC3_calendarExtensionKeepsTheStrictCheckGreen() public {
        string memory json = _mainnetDeploy();
        _acceptAll(json);
        (string memory f, string memory path) = _writeJson(json);
        Valuer v = Valuer(_a(json, "valuer"));
        uint256 extended = script.CALENDAR_VALID_UNTIL() + 365 days;
        vm.prank(owner);
        v.setCalendarValidUntil(extended);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        v.setCalendarValidUntil(extended);
        assertEq(v.calendarValidUntil(), extended);
        new MainnetBeta().verifyDeploymentStrict(f);
        vm.removeFile(path);
    }

    /// R3-ORC-5: OWNER disables a compromised attester at once; its signatures stop working immediately, and a
    /// rotation (48 h) brings a new one in.
    function test_R3ORC5_compromisedAttesterDisabledAtOnce() public {
        (address att, uint256 attKey) = makeAddrAndKey("attester-key");
        EligibilityRegistry reg = new EligibilityRegistry(owner, att);
        address fresh = makeAddr("fresh-attester");
        vm.startPrank(owner);
        reg.setAttester(fresh); // rotation: queued
        reg.disableAttester(); // and the old key is out now
        vm.stopPrank();
        assertEq(reg.attester(), address(0));
        address blocked = makeAddr("blocked-person");
        uint64 issued = uint64(block.timestamp);
        uint64 expiry = issued + 30 days;
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(attKey, reg.attestationDigest(blocked, issued, expiry, 0));
        vm.expectRevert(EligibilityRegistry.BadSignature.selector);
        reg.attest(blocked, issued, expiry, 0, abi.encodePacked(r, s, vv));
        assertFalse(reg.isEligible(blocked));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        reg.disableAttester();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        reg.setAttester(fresh);
        assertEq(reg.attester(), fresh);
    }
}
