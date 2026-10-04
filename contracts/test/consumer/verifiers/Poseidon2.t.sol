// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Poseidon2} from "../../../src/consumer/verifiers/Poseidon2.sol";
import {HiddenConstants} from "../../../src/consumer/verifiers/HiddenConstants.sol";

/// External wrapper so reverts from the library can be expected.
contract Poseidon2Harness {
    function hash2(uint256 a, uint256 b) external pure returns (uint256) {
        return Poseidon2.hash2(a, b);
    }

    function hash4(uint256 a, uint256 b, uint256 c, uint256 d) external pure returns (uint256) {
        return Poseidon2.hash4(a, b, c, d);
    }

    function zeros(uint256 level) external pure returns (uint256) {
        return HiddenConstants.zeros(level);
    }
}

/// Solidity Poseidon2 must equal Noir's on 100 inputs per function (fixtures from
/// circuits/scripts/fixtures.ts, which executes circuits/poseidon2_fixture with the ACVM).
contract Poseidon2Test is Test {
    uint256 constant N = 100;
    string json;
    Poseidon2Harness h;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/verifiers/fixtures/poseidon2.json"));
        h = new Poseidon2Harness();
    }

    function _arr(string memory key) internal view returns (uint256[] memory a) {
        a = vm.parseJsonUintArray(json, key);
        assertEq(a.length, N, key);
    }

    function test_permutationMatchesNoir() public view {
        for (uint256 i; i < N; ++i) {
            uint256[] memory s = vm.parseJsonUintArray(json, string.concat(".states[", vm.toString(i), "]"));
            uint256[] memory want = vm.parseJsonUintArray(json, string.concat(".perms[", vm.toString(i), "]"));
            uint256[4] memory got = Poseidon2.permutation([s[0], s[1], s[2], s[3]]);
            for (uint256 k; k < 4; ++k) {
                assertEq(got[k], want[k], string.concat("perm ", vm.toString(i)));
            }
        }
    }

    function test_hash1MatchesNoir() public view {
        uint256[] memory a = _arr(".a");
        uint256[] memory want = _arr(".h1");
        for (uint256 i; i < N; ++i) {
            assertEq(Poseidon2.hash1(a[i]), want[i]);
        }
    }

    function test_hash2MatchesNoir() public view {
        uint256[] memory a = _arr(".a");
        uint256[] memory b = _arr(".b");
        uint256[] memory want = _arr(".h2");
        for (uint256 i; i < N; ++i) {
            assertEq(Poseidon2.hash2(a[i], b[i]), want[i]);
        }
    }

    function test_hash3MatchesNoir() public view {
        uint256[] memory a = _arr(".a");
        uint256[] memory b = _arr(".b");
        uint256[] memory c = _arr(".c");
        uint256[] memory want = _arr(".h3");
        for (uint256 i; i < N; ++i) {
            assertEq(Poseidon2.hash3(a[i], b[i], c[i]), want[i]);
        }
    }

    function test_hash4MatchesNoir() public view {
        uint256[] memory a = _arr(".a");
        uint256[] memory b = _arr(".b");
        uint256[] memory c = _arr(".c");
        uint256[] memory d = _arr(".d");
        uint256[] memory want = _arr(".h4");
        for (uint256 i; i < N; ++i) {
            assertEq(Poseidon2.hash4(a[i], b[i], c[i], d[i]), want[i]);
        }
    }

    function test_stdlibKnownDigest() public pure {
        // Barretenberg poseidon2_params.hpp TEST_VECTOR_INPUT / TEST_VECTOR_OUTPUT.
        uint256[4] memory out = Poseidon2.permutation([uint256(0), 1, 2, 3]);
        assertEq(out[0], 0x01bd538c2ee014ed5141b29e9ae240bf8db3fe5b9a38629a9647cf8d76c01737); // not-a-key
        assertEq(out[1], 0x239b62e7db98aa3a2a8f6a0d2fa1709e7a35959aa6c7034814d9daa90cbac662); // not-a-key
        assertEq(out[2], 0x04cbb44c61d928ed06808456bf758cbf0c18d1e15a7b6dbc8245fa7515d5e3cb); // not-a-key
        assertEq(out[3], 0x2e11c5cff2a22c64d01304b778d78f6998eff1ab73163a35603f54794c30847a); // not-a-key
    }

    function test_zeroSubtreesMatchNoirAndChain() public view {
        uint256[] memory want = vm.parseJsonUintArray(json, ".zeros");
        assertEq(want.length, HiddenConstants.TREE_DEPTH + 1);
        assertEq(HiddenConstants.zeros(0), HiddenConstants.ZERO_LEAF);
        assertEq(HiddenConstants.zeros(HiddenConstants.TREE_DEPTH), HiddenConstants.EMPTY_ROOT);
        for (uint256 i; i <= HiddenConstants.TREE_DEPTH; ++i) {
            assertEq(HiddenConstants.zeros(i), want[i]);
            if (i > 0) {
                uint256 z = HiddenConstants.zeros(i - 1);
                assertEq(HiddenConstants.zeros(i), Poseidon2.hash2(z, z));
            }
        }
    }

    function test_zerosRevertsPastDepth() public {
        vm.expectRevert(HiddenConstants.LevelOutOfRange.selector);
        h.zeros(HiddenConstants.TREE_DEPTH + 1);
    }

    function test_hashRejectsNonFieldInput() public {
        vm.expectRevert(Poseidon2.NotAFieldElement.selector);
        h.hash2(Poseidon2.P, 1);
        vm.expectRevert(Poseidon2.NotAFieldElement.selector);
        h.hash4(1, 2, 3, type(uint256).max);
    }

    function testFuzz_hash2Deterministic(uint256 a, uint256 b) public view {
        a = bound(a, 0, Poseidon2.P - 1);
        b = bound(b, 0, Poseidon2.P - 1);
        assertEq(h.hash2(a, b), Poseidon2.hash2(a, b));
        if (a != b) assertTrue(Poseidon2.hash2(a, b) != Poseidon2.hash2(b, a));
    }

    function test_gas() public view {
        uint256 g = gasleft();
        h.hash2(1, 2);
        console2.log("hash2 gas (external call)", g - gasleft());
        g = gasleft();
        h.hash4(1, 2, 3, 4);
        console2.log("hash4 gas (external call)", g - gasleft());
    }
}
