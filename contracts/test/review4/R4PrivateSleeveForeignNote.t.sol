// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {PrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {BoardNoteFixture as F} from "./BoardNoteFixture.sol";

/// review4 R4-TREAS-1 regression. The board took 600 AAPL out (`withdrawToBoard`), deposited it into the pool as its
/// OWN note, withdrew that note to the sleeve with a real proof, and `sweep` debited the book $120k: book 0 while the
/// sleeve's notes stayed shielded (L-6 and PrivateBookOpen bypassed). The book is now debited only for nullifiers a
/// treasury_close proof showed are the sleeve's own notes; anything else is forwarded to the account undebited.
/// Real ShieldedPool, real WithdrawVerifier, real UltraHonk proof (gen-board-note-withdraw.ts).
contract R4PrivateSleeveForeignNoteTest is PrivateSleeveFixture {
    function _boardNoteToSleeve() internal returns (uint256 debited, uint256 forwarded) {
        uint256 book = sleeve.bookUsd();
        vm.startPrank(board);
        account.withdrawToBoard(address(aapl), F.AMOUNT);
        aapl.approve(address(pool), F.AMOUNT);
        pool.deposit(address(aapl), F.AMOUNT, bytes32(F.BOARD_PK), bytes32(F.BLINDING), bytes(""));
        vm.stopPrank();
        _warp(block.timestamp + 2 hours + 1);
        pool.insertPending(10);
        assertEq(pool.currentRoot(), bytes32(F.ROOT), "fixture tree (3 sleeve notes + board note) == pool tree");

        ShieldedPool.PublicWithdraw memory w;
        w.root = bytes32(F.ROOT);
        w.nullifier = bytes32(F.NF);
        w.asset = address(aapl);
        w.amount = F.AMOUNT;
        w.recipient = address(sleeve);
        pool.withdraw(F.PROOF, w);

        uint256 acct = aapl.balanceOf(address(account));
        sleeve.sweep(bytes32(F.NF), address(aapl), F.AMOUNT); // forwarded, never debited
        forwarded = aapl.balanceOf(address(account)) - acct;
        debited = book - sleeve.bookUsd();
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.AlreadyForwarded.selector, bytes32(F.NF)));
        sleeve.sweep(bytes32(F.NF), address(aapl), F.AMOUNT);
    }

    function _check(uint256 book, uint256 debited, uint256 forwarded) internal {
        assertEq(debited, 0, "a note never in the book debits nothing");
        assertEq(sleeve.bookUsd(), book, "book unchanged");
        assertEq(forwarded, F.AMOUNT, "the board's tokens still reach the account (exits never stuck)");
        assertFalse(sleeve.isSleeveNullifier(bytes32(F.NF)));
        vm.prank(board);
        vm.expectRevert(TreasuryAccount.PrivateBookOpen.selector);
        account.setPrivateSleeve(address(0), bytes32(0));
    }

    function test_r4_foreignNoteSweptIntoSleeveDoesNotDebitTheBook() public {
        _shieldBook();
        uint256 book = sleeve.bookUsd();
        _warp(block.timestamp + PERIOD + 4 days + 1);
        assertTrue(sleeve.bookStale());
        (uint256 debited, uint256 forwarded) = _boardNoteToSleeve();
        _check(book, debited, forwarded);
        assertTrue(sleeve.bookStale(), "L-6 stale refusal still on");
    }

    /// Same after a proven refresh (the sleeve's nullifiers are recorded): a foreign nullifier is still not one.
    function test_r4_foreignNoteAfterAProvenBookDoesNotDebit() public {
        _shieldBook();
        _proveBook();
        uint256 book = sleeve.bookUsd();
        (uint256 debited, uint256 forwarded) = _boardNoteToSleeve();
        _check(book, debited, forwarded);
    }
}
