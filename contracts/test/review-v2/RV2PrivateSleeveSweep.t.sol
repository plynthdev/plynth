// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {PrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";

/// review-v2 V2-L8 regression. The PoC recycled the board's own AAPL (withdrawToBoard -> transfer to the sleeve ->
/// `sweep(asset)`) to drive `bookUsd` to 0 while the notes were still in the pool: a zero book is never stale (L-6
/// bypass) and a sleeve with a zero book can be dropped (PrivateBookOpen bypass). `sweep` now debits only a proven
/// pool withdraw to the sleeve (the pool's record of what it paid the sleeve, each nullifier once), so the loop cannot start.
contract RV2PrivateSleeveSweepTest is PrivateSleeveFixture {
    /// A forged withdraw for `raw` of AAPL paid to the sleeve (the attacker's best guess at a "proceeds" claim).
    function _forged(uint256 raw) internal view returns (ShieldedPool.PublicWithdraw memory w) {
        w = _withdrawPub();
        w.nullifier = bytes32(uint256(0xdead));
        w.amount = raw;
    }

    function _recycleAttempt() internal {
        uint256 x = aapl.balanceOf(address(account));
        vm.startPrank(board);
        account.withdrawToBoard(address(aapl), x);
        aapl.transfer(address(sleeve), x);
        vm.stopPrank();
        // no withdraw happened: the fixture proof's nullifier is unspent, and a forged one is unspent too
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.NotWithdrawnHere.selector, _withdrawPub().nullifier));
        sleeve.sweep(_withdrawPub().nullifier, address(aapl), x);
        ShieldedPool.PublicWithdraw memory f = _forged(x);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.NotWithdrawnHere.selector, f.nullifier));
        sleeve.sweep(f.nullifier, address(aapl), x);
    }

    function test_rv2_boardCannotRecycleSweepToZeroBook() public {
        _shieldBook();
        uint256 book = sleeve.bookUsd();
        assertGt(book, 0);
        _warp(block.timestamp + PERIOD + 4 days + 1);
        assertTrue(sleeve.bookStale(), "stale: new shields refused");

        _recycleAttempt();
        assertEq(sleeve.bookUsd(), book, "book untouched by a plain transfer");
        assertTrue(sleeve.bookStale(), "still stale");

        // L-6 holds: a shield into the (still open, stale) book is refused until a fresh proof.
        aapl.mint(address(account), 10e18);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.GuardRejected.selector, uint8(18)));
        vm.prank(privKey);
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), 10e18, bytes32(uint256(0x77))), new bytes32[](0), 0);
    }

    function test_rv2_sleeveWithOpenBookCannotBeDropped() public {
        _shieldBook();
        _recycleAttempt();
        assertGt(sleeve.bookUsd(), 0);
        vm.prank(board);
        vm.expectRevert(TreasuryAccount.PrivateBookOpen.selector);
        account.setPrivateSleeve(address(0), bytes32(0));
        assertEq(account.privateSleeve(), address(sleeve));
    }

    /// Even after one real withdraw to the sleeve, its proceeds debit the book once; repeating the sweep with the
    /// board's AAPL transferred in is refused, so the book cannot go below the notes still in the pool.
    function test_rv2_realProceedsDebitOnlyOnce() public {
        _shieldBook();
        _proveBook(); // the sleeve's notes are proven: their withdraws debit the book
        uint256 book = sleeve.bookUsd();
        pool.withdraw(_hex(".withdraw.proofHex"), _withdrawPub());
        sleeve.sweep(_withdrawPub().nullifier, address(aapl), _withdrawPub().amount);
        assertEq(sleeve.bookUsd(), book - 40_000e18);
        uint256 x = aapl.balanceOf(address(account));
        vm.startPrank(board);
        account.withdrawToBoard(address(aapl), x);
        aapl.transfer(address(sleeve), x);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.AlreadyForwarded.selector, _withdrawPub().nullifier));
        sleeve.sweep(_withdrawPub().nullifier, address(aapl), _withdrawPub().amount);
        assertEq(sleeve.bookUsd(), book - 40_000e18, "book still counts the notes left in the pool");
    }
}
