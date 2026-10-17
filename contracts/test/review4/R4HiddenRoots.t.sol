// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {ThresholdVerifier} from "../../src/consumer/ThresholdVerifier.sol";
import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {PrivateSleeve, IPrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";

contract AcceptAllR4 {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

/// review I-3 regression. ShieldedPool accepts a full tree's archived final root for spends (`isKnownRoot` =
/// rootSeq != 0 || archivedRoot), but ThresholdVerifier.checkHoldings and PrivateSleeve.checkClose required
/// `rootSeq`, so notes reachable only through that root were spendable but not provable. Both now use
/// `isKnownRoot`. Simulated with vm.store (filling 2^20 leaves is out of reach in a unit test).
contract R4HiddenRootsTest is Test {
    ShieldedPool pool;
    ThresholdVerifier tv;

    function setUp() public {
        AcceptAllR4 v = new AcceptAllR4();
        pool = new ShieldedPool(IHonkVerifier(address(v)), IHonkVerifier(address(v)), address(this), 48 hours);
        tv = new ThresholdVerifier(pool, IHonkVerifier(address(v)), IHonkVerifier(address(v)));
    }

    function _claim(bytes32 root) internal pure returns (ThresholdVerifier.HoldingsClaim memory c) {
        c.root = root;
        c.asset = address(0xBEEF);
        c.threshold = 1;
        c.nullifiers[0] = bytes32(uint256(5));
    }

    /// Does checkHoldings get past the root check?
    function _provable(bytes32 root) internal view returns (bool) {
        try tv.checkHoldings("", _claim(root), address(this), bytes32(0)) {
            return true;
        } catch (bytes memory err) {
            return bytes4(err) != ThresholdVerifier.UnknownRoot.selector;
        }
    }

    function test_r4_archivedOnlyRootIsProvable() public {
        bytes32 root = keccak256("final root of tree 0");
        vm.store(address(pool), keccak256(abi.encode(root, uint256(31))), bytes32(uint256(1))); // archivedRoot @31
        assertTrue(pool.archivedRoot(root));
        assertEq(pool.rootSeq(root), 0);
        assertTrue(pool.isKnownRoot(root), "spends accept it");
        ThresholdVerifier.HoldingsResult memory r = tv.checkHoldings("", _claim(root), address(this), bytes32(0));
        assertEq(r.poolRootSeq, 0, "archived-only roots report sequence 0");
    }

    /// The general property: for any root and any pool state, provable == spendable.
    function testFuzz_provableExactlyWhereSpendable(bytes32 root, uint8 state) public {
        if (state % 3 == 1) vm.store(address(pool), keccak256(abi.encode(root, uint256(29))), bytes32(uint256(7))); // rootSeq
        if (state % 3 == 2) vm.store(address(pool), keccak256(abi.encode(root, uint256(31))), bytes32(uint256(1))); // archived
        assertEq(_provable(root), pool.isKnownRoot(root));
    }
}

/// The same for the private sleeve's close: an archived-only root reaches the proof check instead of UnknownRoot.
contract R4HiddenRootsSleeveTest is PrivateSleeveFixture {
    function test_r4_sleeveCloseAcceptsArchivedOnlyRoot() public {
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        p.root = keccak256("final root of tree 0");
        vm.store(address(pool), keccak256(abi.encode(p.root, uint256(31))), bytes32(uint256(1)));
        IPrivateSleeve.BookContext memory ctx = _ctx(6000);
        vm.expectRevert(PrivateSleeve.InvalidProof.selector); // past the root check; the fixture proof is for another root
        sleeve.checkClose(p, ctx);
    }
}
