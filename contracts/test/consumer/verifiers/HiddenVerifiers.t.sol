// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TransferVerifier} from "../../../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../../../src/consumer/verifiers/WithdrawVerifier.sol";

interface IHonk {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// Generated UltraHonk (ZK, keccak) verifiers accept proofs made client-side by
/// circuits/scripts/prove.ts (noir_js + bb.js) and reject any tampering.
abstract contract VerifierCase is Test {
    IHonk v;
    bytes proof;
    bytes32[] pub;

    function _name() internal pure virtual returns (string memory);
    function _deploy() internal virtual returns (IHonk);

    function setUp() public {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/test/consumer/verifiers/fixtures/", _name(), "_proof.json")
        );
        proof = vm.parseBytes(string.concat("0x", vm.parseJsonString(json, ".proofHex")));
        uint256[] memory inputs = vm.parseJsonUintArray(json, ".publicInputs");
        for (uint256 i; i < inputs.length; ++i) {
            pub.push(bytes32(inputs[i]));
        }
        v = _deploy();
    }

    /// true only if verify() returned true; a revert counts as rejection.
    function _accepts(bytes memory p, bytes32[] memory inputs) internal view returns (bool) {
        try v.verify(p, inputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function test_acceptsClientProof() public view {
        uint256 g = gasleft();
        assertTrue(v.verify(proof, pub));
        console2.log(string.concat(_name(), " verify gas"), g - gasleft());
    }

    function test_rejectsEachFlippedPublicInput() public view {
        for (uint256 i; i < pub.length; ++i) {
            bytes32[] memory bad = _copy(pub);
            bad[i] = bytes32(uint256(bad[i]) ^ 1);
            assertFalse(_accepts(proof, bad), string.concat("flipped input ", vm.toString(i)));
        }
    }

    function test_rejectsTamperedProof() public view {
        bytes memory bad = bytes.concat(proof);
        bad[bad.length / 2] = bytes1(uint8(bad[bad.length / 2]) ^ 0x01);
        assertFalse(_accepts(bad, pub));
    }

    function test_rejectsWrongPublicInputCount() public view {
        bytes32[] memory shorter = new bytes32[](pub.length - 1);
        for (uint256 i; i < shorter.length; ++i) {
            shorter[i] = pub[i];
        }
        assertFalse(_accepts(proof, shorter));
    }

    function _copy(bytes32[] memory a) internal pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }
}

contract TransferVerifierTest is VerifierCase {
    function _name() internal pure override returns (string memory) {
        return "transfer";
    }

    function _deploy() internal override returns (IHonk) {
        return IHonk(address(new TransferVerifier()));
    }

    /// Public input order is the pool's ABI: root, nullifier[2], outCommitment[2], assetId.
    function test_publicInputLayout() public view {
        assertEq(pub.length, 6);
        assertEq(uint256(pub[5]), uint256(uint160(0x5FbDB2315678afecb367f032d93F642f64180aa3)));
    }

    function test_rejectsSwappedNullifiers() public view {
        bytes32[] memory bad = _copy(pub);
        (bad[1], bad[2]) = (bad[2], bad[1]);
        assertFalse(_accepts(proof, bad));
    }

    function test_rejectsOtherAsset() public view {
        bytes32[] memory bad = _copy(pub);
        bad[5] = bytes32(uint256(uint160(address(0xBEEF))));
        assertFalse(_accepts(proof, bad));
    }
}

contract WithdrawVerifierTest is VerifierCase {
    function _name() internal pure override returns (string memory) {
        return "withdraw";
    }

    function _deploy() internal override returns (IHonk) {
        return IHonk(address(new WithdrawVerifier()));
    }

    /// root, nullifier, changeCommitment, assetId, amount, recipient, relayerFee.
    function test_publicInputLayout() public view {
        assertEq(pub.length, 7);
        assertEq(uint256(pub[4]), 600_000);
        assertEq(uint256(pub[5]), uint256(uint160(0x70997970C51812dc3A010C7d01b50e0d17dc79C8)));
        assertEq(uint256(pub[6]), 1_000);
    }

    /// A relayer cannot redirect the payout or raise its fee.
    function test_relayerCannotRedirectOrRaiseFee() public view {
        bytes32[] memory bad = _copy(pub);
        bad[5] = bytes32(uint256(uint160(address(0xBAD))));
        assertFalse(_accepts(proof, bad));
        bad = _copy(pub);
        bad[6] = bytes32(uint256(2_000));
        assertFalse(_accepts(proof, bad));
        bad = _copy(pub);
        bad[4] = bytes32(uint256(700_000));
        assertFalse(_accepts(proof, bad));
    }
}
