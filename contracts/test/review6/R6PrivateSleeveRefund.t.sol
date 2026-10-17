// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {IPrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";

contract AcceptAllR6R {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

/// review6 R6-TREAS-2 regression (PoC: test/review6x/R6PrivateSleeve.t.sol on the review branch). A shield still
/// pending in the pool when a proof lands is not in the proof, so the proof already left it out of the book; a later
/// `refund` used to debit its `pendingUsd` a second time from notes still shielded, and an empty book let the period
/// close on the public path. A refund now debits only shields made since the last proof (`pendingEpoch`).
contract R6PrivateSleeveRefundTest is PrivateSleeveFixture {
    function _etch() internal {
        vm.etch(address(pool.withdrawVerifier()), address(new AcceptAllR6R()).code);
        vm.etch(address(closeVerifier), address(new AcceptAllR6R()).code);
    }

    function test_r6_refundAfterProofDoesNotDebitTheBookAgain() public {
        _etch();
        _shieldBook(); // $120k of sleeve notes, inserted
        IPrivateSleeve.PrivateClose memory p = _private();
        vm.prank(stranger);
        pc.refreshPrivateBook(p);
        uint256 proven = sleeve.bookUsd();

        uint256 firstPending = pool.pendingCount();
        for (uint256 i; i < 3; ++i) {
            _shield(address(aapl), 200e18, bytes32(uint256(0xa000 + i)));
        }
        _warp(block.timestamp + 1 hours);
        vm.prank(stranger);
        pc.refreshPrivateBook(p);
        assertEq(sleeve.bookUsd(), proven, "the proof left the pending shields out");

        vm.startPrank(stranger);
        for (uint256 i; i < 3; ++i) {
            sleeve.refund(firstPending + i);
        }
        vm.stopPrank();
        assertEq(sleeve.bookUsd(), proven, "the refunds debit nothing: the proven notes stay in the book");
        assertEq(sleeve.pendingUsd(firstPending), 0);
        assertEq(sleeve.pendingEpoch(firstPending), 0);

        // The public path stays closed while the proven notes are shielded (PrivateBookOpen).
        _warp(block.timestamp + PERIOD + 4 days + 1);
        PeriodClose.Close memory c = _build(0);
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PrivateBookOpen.selector, proven));
        pc.commit(c, sig);
    }

    /// Control: a refund with no proof in between still takes the shield off the book exactly once.
    function test_r6_refundBeforeAnyProofDebitsOnce() public {
        _etch();
        _shieldBook();
        IPrivateSleeve.PrivateClose memory p = _private();
        vm.prank(stranger);
        pc.refreshPrivateBook(p);
        uint256 proven = sleeve.bookUsd();
        uint256 id = pool.pendingCount();
        _shield(address(aapl), 200e18, bytes32(uint256(0xb000)));
        uint256 usd = sleeve.pendingUsd(id);
        assertEq(sleeve.bookUsd(), proven + usd);
        vm.prank(stranger);
        sleeve.refund(id);
        assertEq(sleeve.bookUsd(), proven, "debited once");
        assertEq(sleeve.shieldedSinceProofUsd(), 0);
    }

    /// review6 R6-TREAS-3 regression (capital-free variant of R6-TREAS-1): a proven note unshielded to the account and
    /// then withdrawn by the board used to leave the claim basis unchanged (the public balance went up and back down,
    /// the proven part kept counting). The basis now counts the sleeve's book (at most the proven part) and the
    /// low-water mark, so the $50k that left comes off.
    function test_r6_unshieldedProvenNoteWithdrawnLowersTheClaimBasis() public {
        _etch();
        _shieldBook();
        _warp(block.timestamp + PERIOD + 4 days + 1);
        IPrivateSleeve.PrivateClose memory p = _private();
        PeriodClose.Close memory c = _build(p.navUsd);
        pc.commitWithPrivateSleeve(c, _sign(c), p);
        uint256 basis0 = pc.claimBasisNow();

        bytes32 nf = p.nullifiers[0];
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = nf;
        w.asset = address(aapl);
        w.amount = 250e18;
        w.recipient = address(sleeve);
        pool.withdraw("", w);
        sleeve.sweep(nf, address(aapl), 250e18);
        assertApproxEqAbs(pc.claimBasisNow(), basis0, 1e6, "unshielding moves value inside the basis");
        vm.prank(board);
        account.withdrawToBoard(address(aapl), 250e18);
        uint256 basis1 = pc.claimBasisNow();
        assertApproxEqRel(basis0 - basis1, 50_000e18, 1e15, "the $50k that left is off the basis");
        // and putting the stock back does not restore it
        vm.prank(board);
        aapl.transfer(address(account), 250e18);
        assertEq(pc.claimBasisNow(), basis1, "the low-water mark holds");
    }
}
