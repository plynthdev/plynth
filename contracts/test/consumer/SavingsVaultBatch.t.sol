// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {SavingsVaultBase} from "./SavingsVaultBase.sol";

/// Review v3 R3-SVC-2 follow-up: accrueBatch lets the keeper send a user's carried sub-minimum round-ups together.
/// It must be exactly the same accrues one after another: same keys burned, same clipping, one Accrued per spend.
contract SavingsVaultBatchTest is SavingsVaultBase {
    bytes32 internal constant ACCRUED_SIG = keccak256("Accrued(address,bytes32,uint32,uint256,uint256,uint64)");

    function _arrays(uint256 n, bytes32 salt, uint256 spend)
        internal
        pure
        returns (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends)
    {
        txs = new bytes32[](n);
        logs = new uint32[](n);
        spends = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            txs[i] = keccak256(abi.encode(salt, i));
            logs[i] = uint32(i);
            spends[i] = spend;
        }
    }

    function _batch(address user, bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends)
        internal
        returns (uint256)
    {
        vm.prank(keeper);
        return vault.accrueBatch(user, txs, logs, spends);
    }

    function _key(bytes32 t, uint32 l) internal pure returns (bytes32) {
        return keccak256(abi.encode(t, l));
    }

    function test_batch_fiveOneCentRoundUpsEqualFiveAccruesAndEmitFiveEvents() public {
        _fund(alice, 10 * U);
        _fund(bob, 10 * U);
        _settings(alice, 1, 1, 100 * U, 0);
        _settings(bob, 1, 1, 100 * U, 0);
        // 0.99 USDG spends: a 1-cent round-up each
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(5, "alice", 990_000);
        (bytes32[] memory txsB, uint32[] memory logsB,) = _arrays(5, "bob", 990_000);

        uint256 separate;
        for (uint256 i; i < 5; ++i) {
            vm.prank(keeper);
            separate += vault.accrue(bob, txsB[i], logsB[i], spends[i]);
        }

        uint64 week = uint64(block.timestamp / 1 weeks);
        for (uint256 i; i < 5; ++i) {
            vm.expectEmit(address(vault));
            emit SavingsVault.Accrued(alice, txs[i], logs[i], 990_000, 10_000, week);
        }
        vm.recordLogs();
        uint256 batched = _batch(alice, txs, logs, spends);
        Vm.Log[] memory evs = vm.getRecordedLogs();
        uint256 accrued;
        for (uint256 i; i < evs.length; ++i) {
            if (evs[i].emitter == address(vault) && evs[i].topics[0] == ACCRUED_SIG) ++accrued;
        }

        assertEq(accrued, 5);
        assertEq(batched, 50_000);
        assertEq(batched, separate);
        assertEq(_pend(alice), _pend(bob));
        assertEq(_avail(alice), _avail(bob));
        assertEq(vault.accountOf(alice).accruedThisWeek, vault.accountOf(bob).accruedThisWeek);
        for (uint256 i; i < 5; ++i) {
            assertTrue(vault.sourceUsed(_key(txs[i], logs[i])));
        }
    }

    function test_batch_alreadyAccruedKeyRevertsAndBurnsNothing() public {
        _fund(alice, 10 * U);
        _settings(alice, 1, 1, 100 * U, 0);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(4, "replay", 990_000);
        vm.prank(keeper);
        vault.accrue(alice, txs[2], logs[2], spends[2]);
        uint256 pendBefore = _pend(alice);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, txs[2], logs[2]));
        vault.accrueBatch(alice, txs, logs, spends);

        assertEq(_pend(alice), pendBefore);
        assertFalse(vault.sourceUsed(_key(txs[0], logs[0])));
        assertFalse(vault.sourceUsed(_key(txs[1], logs[1])));
        assertFalse(vault.sourceUsed(_key(txs[3], logs[3])));
    }

    function test_batch_duplicateKeyInsideOneBatchReverts() public {
        _fund(alice, 10 * U);
        _settings(alice, 1, 1, 100 * U, 0);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(3, "dup", 990_000);
        txs[2] = txs[0];
        logs[2] = logs[0];
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, txs[0], logs[0]));
        vault.accrueBatch(alice, txs, logs, spends);
        assertFalse(vault.sourceUsed(_key(txs[0], logs[0])));
        assertEq(_pend(alice), 0);
    }

    function test_batch_aboveMaxReverts() public {
        _fund(alice, 10 * U);
        _settings(alice, 1, 1, 100 * U, 0);
        uint256 max = vault.MAX_ACCRUE_BATCH();
        assertEq(max, 32);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(max + 1, "big", 990_000);
        vm.prank(keeper);
        vm.expectRevert(SavingsVault.InvalidBatch.selector);
        vault.accrueBatch(alice, txs, logs, spends);

        (txs, logs, spends) = _arrays(max, "max", 990_000);
        uint256 g = gasleft();
        assertEq(_batch(alice, txs, logs, spends), max * 10_000);
        emit log_named_uint("gas for a full accrueBatch", g - gasleft());
    }

    function test_batch_lengthMismatchAndEmptyRevert() public {
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(3, "len", 990_000);
        (bytes32[] memory txs2, uint32[] memory logs2, uint256[] memory spends2) = _arrays(2, "len", 990_000);
        vm.startPrank(keeper);
        vm.expectRevert(SavingsVault.InvalidBatch.selector);
        vault.accrueBatch(alice, txs2, logs, spends);
        vm.expectRevert(SavingsVault.InvalidBatch.selector);
        vault.accrueBatch(alice, txs, logs2, spends);
        vm.expectRevert(SavingsVault.InvalidBatch.selector);
        vault.accrueBatch(alice, txs, logs, spends2);
        vm.expectRevert(SavingsVault.InvalidBatch.selector);
        vault.accrueBatch(alice, new bytes32[](0), new uint32[](0), new uint256[](0));
        vm.stopPrank();
    }

    function test_batch_weeklyCapClipsCumulativelyAcrossTheBatch() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 3, uint64(40 * U), 0);
        // 1 USDG spends: 9 x3 = 27 each; cap 40 -> 27, 13, 0
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(3, "cap", 1 * U);
        uint64 week = uint64(block.timestamp / 1 weeks);
        vm.expectEmit(address(vault));
        emit SavingsVault.Accrued(alice, txs[0], logs[0], 1 * U, 27 * U, week);
        vm.expectEmit(address(vault));
        emit SavingsVault.Accrued(alice, txs[1], logs[1], 1 * U, 13 * U, week);
        vm.expectEmit(address(vault));
        emit SavingsVault.Accrued(alice, txs[2], logs[2], 1 * U, 0, week);
        assertEq(_batch(alice, txs, logs, spends), 40 * U);
        assertEq(vault.accountOf(alice).accruedThisWeek, 40 * U);
        assertEq(_pend(alice), 40 * U);
        assertTrue(vault.sourceUsed(_key(txs[2], logs[2]))); // a 0 still burns its key, as accrue does
    }

    function test_batch_clipsToAvailableCumulatively() public {
        _fund(alice, 30 * U);
        _settings(alice, 10, 3, 500 * U, 0);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(3, "avail", 1 * U);
        assertEq(_batch(alice, txs, logs, spends), 30 * U); // 27 + 3 + 0
        assertEq(_avail(alice), 0);
        assertEq(_pend(alice), 30 * U);
    }

    function test_batch_onlyKeeper() public {
        _fund(alice, 10 * U);
        _settings(alice, 1, 1, 100 * U, 0);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(2, "auth", 990_000);
        address[3] memory who = [alice, owner, crowd];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(SavingsVault.NotKeeper.selector);
            vault.accrueBatch(alice, txs, logs, spends);
        }
        assertEq(_pend(alice), 0);
    }

    /// Fuzz: any batch equals the same accrues one by one, on a twin user with the same state.
    function testFuzz_batch_matchesSequentialAccrues(uint256[8] memory raw, uint8 n, uint64 cap, uint256 fund)
        public
    {
        uint256 len = bound(n, 1, 8);
        cap = uint64(bound(cap, 0, 500 * U));
        fund = bound(fund, 0, 1_000 * U);
        if (fund > 0) {
            _fund(alice, fund);
            _fund(bob, fund);
        }
        _settings(alice, 5, 2, cap, 0);
        _settings(bob, 5, 2, cap, 0);
        (bytes32[] memory txs, uint32[] memory logs, uint256[] memory spends) = _arrays(len, "fa", 0);
        (bytes32[] memory txsB, uint32[] memory logsB,) = _arrays(len, "fb", 0);
        for (uint256 i; i < len; ++i) {
            spends[i] = bound(raw[i], 0, 1e12);
        }
        uint256 seq;
        for (uint256 i; i < len; ++i) {
            vm.prank(keeper);
            seq += vault.accrue(bob, txsB[i], logsB[i], spends[i]);
        }
        assertEq(_batch(alice, txs, logs, spends), seq);
        assertEq(_pend(alice), _pend(bob));
        assertEq(_avail(alice), _avail(bob));
        assertEq(vault.accountOf(alice).accruedThisWeek, vault.accountOf(bob).accruedThisWeek);
    }
}
