// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";

/// Cross-checks app/src/treasury/policy-compiler against Solidity: every compiled template must pass validate(),
/// hash to the same keccak256(abi.encode(p)), and every instrument proof must verify with OpenZeppelin
/// MerkleProof against the compiled root. Regenerate with `bun app/src/treasury/policy-compiler/fixture.ts`.
contract PolicyCompilerFixtureTest is Test {
    string json;
    TreasuryPolicy tp;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/treasury/fixtures/policy-compiler.json"));
    }

    function _k(string memory t, string memory field) internal pure returns (string memory) {
        return string.concat(".", t, ".", field);
    }

    function _u(string memory t, string memory f) internal view returns (uint256) {
        return vm.parseJsonUint(json, _k(t, f));
    }

    function _i(string memory t, string memory f) internal view returns (int16) {
        return int16(vm.parseJsonInt(json, _k(t, f)));
    }

    function _policy(string memory t) internal view returns (TreasuryPolicy.Policy memory p) {
        p.cash = TreasuryPolicy.Band(uint16(_u(t, "cashMin")), uint16(_u(t, "cashMax")));
        p.equity = TreasuryPolicy.Band(uint16(_u(t, "equityMin")), uint16(_u(t, "equityMax")));
        p.basis = TreasuryPolicy.Band(uint16(_u(t, "basisMin")), uint16(_u(t, "basisMax")));
        p.netDeltaMinBps = _i(t, "netDeltaMinBps");
        p.netDeltaMaxBps = _i(t, "netDeltaMaxBps");
        p.maxLeverageX10 = uint16(_u(t, "maxLeverageX10"));
        p.perOrderCapUsd = uint64(_u(t, "perOrderCapUsd"));
        p.perDayCapUsd = uint64(_u(t, "perDayCapUsd"));
        p.perNameFloatCapBps = uint16(_u(t, "perNameFloatCapBps"));
        p.perVenueCapBps = uint16(_u(t, "perVenueCapBps"));
        p.noNewRiskOffHours = vm.parseJsonBool(json, _k(t, "noNewRiskOffHours"));
        p.pauseNewRiskAtDrawdownBps = _i(t, "pauseNewRiskAtDrawdownBps");
        p.deriskAtDrawdownBps = _i(t, "deriskAtDrawdownBps");
        p.approvalAboveUsd = uint64(_u(t, "approvalAboveUsd"));
        p.periodSeconds = uint32(_u(t, "periodSeconds"));
        p.instrumentAllowRoot = bytes32(_u(t, "instrumentAllowRoot"));
        p.venueAllowRoot = bytes32(_u(t, "venueAllowRoot"));
        p.controller = vm.parseJsonAddress(json, _k(t, "controller"));
    }

    function _check(string memory t) internal {
        TreasuryPolicy.Policy memory p = _policy(t);
        assertEq(uint256(keccak256(abi.encode(p))), _u(t, "hash"), string.concat(t, ": hash"));
        tp = new TreasuryPolicy(makeAddr("board"), p, 48 hours); // runs validate()
        (, bytes32 h,) = tp.current();
        assertEq(uint256(h), _u(t, "hash"));

        uint256 n = _u(t, "leafCount");
        assertGt(n, 0);
        for (uint256 i = 0; i < n; i++) {
            string memory base = string.concat(".", t, ".leaves[", vm.toString(i), "]");
            address asset = vm.parseJsonAddress(json, string.concat(base, ".asset"));
            uint8 kind = uint8(vm.parseJsonUint(json, string.concat(base, ".kind")));
            uint256[] memory raw = vm.parseJsonUintArray(json, string.concat(base, ".proof"));
            bytes32[] memory proof = new bytes32[](raw.length);
            for (uint256 j = 0; j < raw.length; j++) proof[j] = bytes32(raw[j]);
            bytes32 leaf = keccak256(abi.encode(asset, kind));
            assertTrue(MerkleProof.verify(proof, p.instrumentAllowRoot, leaf), string.concat(t, ": proof ", vm.toString(i)));
            assertTrue(tp.isInstrumentAllowed(asset, kind, proof));
            assertFalse(tp.isInstrumentAllowed(asset, kind + 1, proof)); // kind is bound into the leaf
        }
    }

    function test_conservative() public {
        _check("conservative");
        assertEq(_u("conservative", "cashMin"), 7000);
        assertEq(_u("conservative", "cashMax"), 9000);
        assertEq(_u("conservative", "equityMin"), 1000);
        assertEq(_u("conservative", "equityMax"), 3000);
    }

    function test_balanced() public {
        _check("balanced");
        assertEq(_u("balanced", "cashMin"), 4000);
        assertEq(_u("balanced", "cashMax"), 7000);
        assertEq(_u("balanced", "equityMin"), 3000);
        assertEq(_u("balanced", "equityMax"), 6000);
    }

    function test_carryEqualsBalancedInT1() public {
        _check("carry");
        assertEq(keccak256(abi.encode(_policy("carry"))), keccak256(abi.encode(_policy("balanced"))));
    }
}
