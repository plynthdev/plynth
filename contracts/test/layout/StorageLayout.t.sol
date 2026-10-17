// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";

/// Storage-layout snapshot (review4 I-3): `withdrawnOf` was inserted mid-layout and moved ShieldedPool's
/// `archivedRoot` from slot 31 to 32, silently breaking anything that addressed it by slot. Each check writes a raw
/// slot and reads it back through the public getter, so a reordered, inserted or retyped variable fails here.
/// New variables go at the END of a contract's storage; when a layout change is intended, update this snapshot
/// in the same commit (`forge inspect <Contract> storageLayout`).
contract StorageLayoutTest is PrivateSleeveFixture {
    bytes32 constant K = bytes32(uint256(0xbeef));

    function _map(address target, bytes32 key, uint256 slot, bytes32 val) internal {
        vm.store(target, keccak256(abi.encode(key, slot)), val);
    }

    function _mapA(address target, address key, uint256 slot, bytes32 val) internal {
        vm.store(target, keccak256(abi.encode(key, slot)), val);
    }

    function test_shieldedPoolLayout() public {
        address p = address(pool);
        vm.store(p, bytes32(uint256(27)), K);
        assertEq(pool.currentRoot(), K, "currentRoot @27");
        _map(p, K, 29, bytes32(uint256(7)));
        assertEq(pool.rootSeq(K), 7, "rootSeq @29");
        _map(p, K, 30, bytes32(uint256(1)));
        assertTrue(pool.nullifierSpent(K), "nullifierSpent @30");
        _map(p, bytes32(uint256(0xcafe)), 31, bytes32(uint256(1)));
        assertTrue(pool.archivedRoot(bytes32(uint256(0xcafe))), "archivedRoot @31");
        _mapA(p, address(aapl), 32, bytes32(uint256(5)));
        assertEq(pool.minDeposit(address(aapl)), 5, "minDeposit @32");
        _mapA(p, address(aapl), 37, bytes32(uint256(9)));
        assertEq(pool.shielded(address(aapl)), 9, "shielded @37");
        _map(p, K, 38, K);
        assertEq(pool.withdrawnOf(K), K, "withdrawnOf @38 (appended)");
    }

    function test_privateSleeveLayout() public {
        address s = address(sleeve);
        vm.store(s, bytes32(uint256(4)), bytes32(uint256(123)));
        assertEq(sleeve.bookUsd(), 123, "bookUsd @4");
        vm.store(s, bytes32(uint256(5)), bytes32(uint256(77)));
        assertEq(sleeve.lastProvenAt(), 77, "lastProvenAt @5");
        _map(s, K, 7, bytes32(uint256(1)));
        assertTrue(sleeve.proceedsForwarded(K), "proceedsForwarded @7");
        _map(s, bytes32(uint256(0xcafe)), 8, bytes32(uint256(1)));
        assertTrue(sleeve.isSleeveNullifier(bytes32(uint256(0xcafe))), "isSleeveNullifier @8");
    }

    function test_periodCloseLayout() public {
        address c = address(pc);
        vm.store(c, bytes32(uint256(9)), bytes32(uint256(11)));
        assertEq(pc.periodStartNav(), 11, "periodStartNav @9");
        vm.store(c, bytes32(uint256(10)), bytes32(uint256(12)));
        assertEq(pc.feeOwed(), 12, "feeOwed @10");
        vm.store(c, bytes32(uint256(18)), bytes32(uint256(13)));
        assertEq(pc.claimBasisNav(), 13, "claimBasisNav @18 (appended)");
        _mapA(c, address(usdg), 19, bytes32(uint256(14)));
        assertEq(pc.withdrawnMark(address(usdg)), 14, "withdrawnMark @19 (appended)");
    }

    function test_treasuryAccountLayout() public {
        address a = address(account);
        assertEq(address(uint160(uint256(vm.load(a, bytes32(uint256(0)))))), board, "board @0");
        assertEq(address(uint160(uint256(vm.load(a, bytes32(uint256(4)))))), account.periodClose(), "periodClose @4");
        assertEq(address(uint160(uint256(vm.load(a, bytes32(uint256(13)))))), account.privateSleeve(), "privateSleeve @13");
        _mapA(a, address(usdg), 16, bytes32(uint256(15)));
        assertEq(account.boardWithdrawn(address(usdg)), 15, "boardWithdrawn @16 (appended)");
        assertEq(address(uint160(uint256(vm.load(a, bytes32(uint256(17)))))), account.factory(), "factory @17 (appended)");
        assertEq(uint64(uint256(vm.load(a, bytes32(uint256(17)))) >> 160), account.setupEndsAt(), "setupEndsAt @17+20");
        _map(a, K, 18, bytes32(uint256(16)));
        assertEq(account.deskEta(K), 16, "deskEta @18 (appended)");
    }
}
