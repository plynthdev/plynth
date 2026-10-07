// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {HiddenConstants} from "../../src/consumer/verifiers/HiddenConstants.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {ShieldedPoolBase, ExpectVerifier} from "./ShieldedPoolBase.sol";

/// ShieldedPool rules with stand-in verifiers (real proofs: ShieldedPoolProofs.t.sol).
contract ShieldedPoolTest is ShieldedPoolBase {
    using stdStorage for StdStorage;

    // ---------------------------------------------------------------- constants and wiring

    function test_treeConstantsMatchCircuits() public view {
        assertEq(pool.TREE_DEPTH(), HiddenConstants.TREE_DEPTH);
        assertEq(pool.currentRoot(), bytes32(HiddenConstants.EMPTY_ROOT));
        assertTrue(pool.isKnownRoot(bytes32(HiddenConstants.EMPTY_ROOT)));
        assertFalse(pool.isKnownRoot(bytes32(0)));
        assertEq(pool.MIN_PENDING_DELAY(), 1 hours);
        assertEq(pool.CAP_DELAY(), 48 hours);
        assertEq(pool.ROOT_HISTORY(), 100);
        assertEq(pool.MAX_NOTE_BYTES(), 512);
    }

    function test_setCrowdOnceOwnerOnly() public {
        ShieldedPool p = new ShieldedPool(tv, wv, owner, 48 hours);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        p.setCrowd(crowdAddr);
        vm.startPrank(owner);
        vm.expectRevert(ShieldedPool.ZeroAddress.selector);
        p.setCrowd(address(0));
        p.setCrowd(crowdAddr);
        vm.expectRevert(ShieldedPool.AlreadySet.selector);
        p.setCrowd(alice);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- rule: commitment on-chain (Poseidon2)

    function test_depositCommitmentIsPoseidon2OfNoteFields() public {
        bytes32 ownerPk = bytes32(uint256(123456789));
        bytes32 blinding = bytes32(uint256(987654321));
        vm.prank(alice);
        uint256 id = pool.deposit(address(usdg), 42 * U, ownerPk, blinding, hex"01");
        bytes32 expected =
            bytes32(Poseidon2.hash4(uint256(uint160(address(usdg))), 42 * U, uint256(ownerPk), uint256(blinding)));
        ShieldedPool.Pending memory p = pool.pending(id);
        assertEq(p.commitment, expected);
        assertEq(pool.commitmentOf(address(usdg), 42 * U, ownerPk, blinding), expected);
        assertEq(p.raw, 42 * U);
        assertEq(p.origin, alice);
        assertEq(uint8(p.state), uint8(ShieldedPool.PendingState.Queued));
    }

    function test_depositRejectsNonFieldOwnerOrBlinding() public {
        vm.startPrank(alice);
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.deposit(address(usdg), U, bytes32(P), bytes32(uint256(1)), "");
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.deposit(address(usdg), U, bytes32(uint256(1)), bytes32(type(uint256).max), "");
        vm.stopPrank();
    }

    function test_depositRejectsZeroAndOver128BitAmounts() public {
        vm.startPrank(alice);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.deposit(address(usdg), 0, bytes32(uint256(1)), bytes32(uint256(1)), "");
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.deposit(address(stock), uint256(type(uint128).max) + 1, bytes32(uint256(1)), bytes32(uint256(1)), "");
        vm.expectRevert(ShieldedPool.ZeroAddress.selector);
        pool.deposit(address(0), 1, bytes32(uint256(1)), bytes32(uint256(1)), "");
        vm.stopPrank();
    }

    function test_depositPullsExactRawAndEmitsEncryptedNote() public {
        bytes memory enc = new bytes(141);
        enc[0] = 0x01;
        bytes32 c = pool.commitmentOf(address(usdg), 5 * U, bytes32(uint256(7)), bytes32(uint256(8)));
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(address(pool));
        emit ShieldedPool.DepositQueued(0, address(usdg), alice, 5 * U, c);
        vm.expectEmit(address(pool));
        emit ShieldedPool.NoteEncrypted(c, enc);
        vm.prank(alice);
        pool.deposit(address(usdg), 5 * U, bytes32(uint256(7)), bytes32(uint256(8)), enc);
        assertEq(before - usdg.balanceOf(alice), 5 * U);
        assertEq(usdg.balanceOf(address(pool)), 5 * U);
        assertEq(pool.shielded(address(usdg)), 5 * U);
    }

    // ---------------------------------------------------------------- rule: encrypted notes are opaque, <= 512 bytes

    function test_encryptedNotesMax512Bytes() public {
        vm.startPrank(alice);
        pool.deposit(address(usdg), U, bytes32(uint256(1)), bytes32(uint256(2)), new bytes(512));
        vm.expectRevert(ShieldedPool.NoteTooLarge.selector);
        pool.deposit(address(usdg), U, bytes32(uint256(1)), bytes32(uint256(3)), new bytes(513));
        vm.stopPrank();
        _insertAll();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg));
        bytes[2] memory e;
        e[0] = new bytes(513);
        vm.expectRevert(ShieldedPool.NoteTooLarge.selector);
        pool.transfer("", t, e);
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(uint256(3)), address(usdg), U, bob, 0);
        w.encryptedChange = new bytes(513);
        vm.expectRevert(ShieldedPool.NoteTooLarge.selector);
        pool.withdraw("", w);
    }

    function test_transferEmitsEncryptedNotesForBothOutputs() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(11)), bytes32(uint256(12)), address(usdg));
        bytes[2] memory e;
        e[0] = hex"aa";
        e[1] = hex"bbbb";
        vm.expectEmit(address(pool));
        emit ShieldedPool.LeafInserted(1, t.outCommitments[0]);
        vm.expectEmit(address(pool));
        emit ShieldedPool.NoteEncrypted(t.outCommitments[0], e[0]);
        vm.expectEmit(address(pool));
        emit ShieldedPool.LeafInserted(2, t.outCommitments[1]);
        vm.expectEmit(address(pool));
        emit ShieldedPool.NoteEncrypted(t.outCommitments[1], e[1]);
        pool.transfer("", t, e);
        assertEq(pool.nextLeaf(), 3);
    }

    // ---------------------------------------------------------------- pending queue

    function test_insertPendingWaitsMinDelay() public {
        _deposit(alice, address(usdg), U, 1);
        vm.expectRevert(ShieldedPool.NothingToInsert.selector);
        pool.insertPending(10);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(ShieldedPool.NothingToInsert.selector);
        pool.insertPending(10);
        assertEq(pool.readyCount(10), 0);
        vm.warp(block.timestamp + 1);
        assertEq(pool.readyCount(10), 1);
        vm.prank(makeAddr("anyone"));
        assertEq(pool.insertPending(10), 1);
        assertEq(pool.nextLeaf(), 1);
        assertEq(uint8(pool.pending(0).state), uint8(ShieldedPool.PendingState.Inserted));
    }

    function test_insertPendingIsFifoAndStopsAtFirstUnready() public {
        _deposit(alice, address(usdg), U, 1);
        vm.warp(block.timestamp + 30 minutes);
        _deposit(bob, address(usdg), U, 2);
        vm.warp(block.timestamp + 30 minutes); // first ready, second not
        assertEq(pool.insertPending(10), 1);
        assertEq(pool.nextPending(), 1);
        vm.expectRevert(ShieldedPool.NothingToInsert.selector);
        pool.insertPending(10);
        vm.warp(block.timestamp + 30 minutes);
        assertEq(pool.insertPending(10), 1);
        assertEq(pool.nextLeaf(), 2);
    }

    function test_insertPendingBoundedByMaxCountAndOneRootPerBatch() public {
        for (uint256 i; i < 5; ++i) {
            _deposit(alice, address(usdg), U, i + 1);
        }
        vm.warp(block.timestamp + 1 hours);
        uint256 roots = pool.rootCount();
        assertEq(pool.insertPending(3), 3);
        assertEq(pool.rootCount(), roots + 1);
        assertEq(pool.insertPending(3), 2);
        assertEq(pool.nextLeaf(), 5);
        vm.expectRevert(ShieldedPool.NothingToInsert.selector);
        pool.insertPending(3);
    }

    function test_refundPendingOriginOnlyUntilInserted() public {
        uint256 id = _deposit(alice, address(usdg), 3 * U, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotOrigin.selector, id));
        pool.refundPending(id);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        pool.refundPending(id);
        assertEq(usdg.balanceOf(alice) - before, 3 * U);
        assertEq(pool.shielded(address(usdg)), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotPending.selector, id));
        pool.refundPending(id);

        uint256 id2 = _deposit(alice, address(usdg), U, 2);
        _insertAll();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotPending.selector, id2));
        pool.refundPending(id2);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotPending.selector, 99));
        pool.refundPending(99);
    }

    function test_refundedEntriesAreSkippedByInsert() public {
        uint256 a = _deposit(alice, address(usdg), U, 1);
        _deposit(bob, address(usdg), U, 2);
        vm.prank(alice);
        pool.refundPending(a);
        vm.warp(block.timestamp + 1 hours);
        assertEq(pool.readyCount(10), 1);
        assertEq(pool.insertPending(10), 1);
        assertEq(pool.nextLeaf(), 1);
        assertEq(pool.nextPending(), 2);
    }

    function test_depositForOnlyCrowdAndOriginCanRefund() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.NotCrowd.selector);
        pool.depositFor(address(stock), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "", alice);
        vm.prank(crowdAddr);
        vm.expectRevert(ShieldedPool.ZeroAddress.selector);
        pool.depositFor(address(stock), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "", address(0));
        uint256 crowdBefore = stock.balanceOf(crowdAddr);
        vm.prank(crowdAddr);
        uint256 id = pool.depositFor(address(stock), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "", alice);
        assertEq(crowdBefore - stock.balanceOf(crowdAddr), 1e18);
        assertEq(pool.pending(id).origin, alice);
        vm.prank(crowdAddr);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotOrigin.selector, id));
        pool.refundPending(id);
        uint256 before = stock.balanceOf(alice);
        vm.prank(alice);
        pool.refundPending(id);
        assertEq(stock.balanceOf(alice) - before, 1e18);
    }

    function test_unsetCrowdCannotDepositFor() public {
        ShieldedPool p = new ShieldedPool(tv, wv, owner, 48 hours);
        vm.prank(address(0));
        vm.expectRevert(ShieldedPool.NotCrowd.selector);
        p.depositFor(address(usdg), 1, bytes32(uint256(1)), bytes32(uint256(1)), "", alice);
    }

    // ---------------------------------------------------------------- rule: caps (deposits only, 48h to raise)

    function test_capsStartAtZero() public {
        ShieldedPool p = new ShieldedPool(tv, wv, owner, 48 hours);
        assertEq(p.cap(address(usdg)), 0);
        vm.startPrank(alice);
        usdg.approve(address(p), U);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.CapExceeded.selector, 0, U, 0));
        p.deposit(address(usdg), U, bytes32(uint256(1)), bytes32(uint256(1)), "");
        vm.stopPrank();
    }

    function test_capRaiseNeeds48hLowerIsImmediate() public {
        address asset = makeAddr("asset");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.proposeCap(asset, 10);
        vm.expectRevert(ShieldedPool.NoProposal.selector);
        pool.applyCap(asset);

        vm.prank(owner);
        pool.proposeCap(asset, 100);
        assertEq(pool.cap(asset), 0);
        (uint256 c, uint64 eta) = pool.capProposal(asset);
        assertEq(c, 100);
        assertEq(eta, block.timestamp + 48 hours);
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TooEarly.selector, eta));
        pool.applyCap(asset);
        vm.warp(eta);
        vm.prank(makeAddr("anyone"));
        pool.applyCap(asset);
        assertEq(pool.cap(asset), 100);

        // lowering applies at once and cancels a pending raise
        vm.prank(owner);
        pool.proposeCap(asset, 500);
        vm.prank(owner);
        pool.proposeCap(asset, 40);
        assertEq(pool.cap(asset), 40);
        (, eta) = pool.capProposal(asset);
        assertEq(eta, 0);
    }

    function test_capEnforcedOnDepositsOnly() public {
        vm.prank(owner);
        pool.proposeCap(address(usdg), 10 * U);
        _deposit(alice, address(usdg), 6 * U, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.CapExceeded.selector, 6 * U, 5 * U, 10 * U));
        pool.deposit(address(usdg), 5 * U, bytes32(uint256(2)), bytes32(uint256(2)), "");
        vm.prank(crowdAddr);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.CapExceeded.selector, 6 * U, 5 * U, 10 * U));
        pool.depositFor(address(usdg), 5 * U, bytes32(uint256(2)), bytes32(uint256(2)), "", alice);
        _deposit(alice, address(usdg), 4 * U, 3); // exactly at cap
        _insertAll();

        // cap to zero: exits still work
        vm.prank(owner);
        pool.proposeCap(address(usdg), 0);
        pool.transfer("", _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg)), _notes());
        pool.withdraw("", _pubW(bytes32(uint256(3)), address(usdg), 10 * U, bob, 0));
        assertEq(pool.shielded(address(usdg)), 0);
    }

    // ---------------------------------------------------------------- rule: exits never gated

    function test_pauseStopsDepositsOnly() public {
        _deposit(alice, address(usdg), 10 * U, 1);
        uint256 id = _deposit(alice, address(usdg), U, 2);
        vm.prank(owner);
        pool.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.Paused.selector);
        pool.deposit(address(usdg), U, bytes32(uint256(1)), bytes32(uint256(1)), "");
        vm.prank(crowdAddr);
        vm.expectRevert(ShieldedPool.Paused.selector);
        pool.depositFor(address(usdg), U, bytes32(uint256(1)), bytes32(uint256(1)), "", alice);

        vm.prank(alice);
        pool.refundPending(id);
        _insertAll();
        pool.transfer("", _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg)), _notes());
        pool.withdraw("", _pubW(bytes32(uint256(3)), address(usdg), 10 * U, bob, 0));
        assertEq(usdg.balanceOf(bob), 10_000_000 * U + 10 * U);
    }

    function test_exitsWorkAfterOwnerRenouncesAndCrowdIsGone() public {
        _deposit(alice, address(stock), 2e18, 1);
        vm.prank(owner);
        pool.setDepositsPaused(true);
        vm.prank(owner);
        pool.renounceOwnership();
        _insertAll(); // anyone
        ShieldedPool.PublicWithdraw memory a1 = _pubW(bytes32(uint256(9)), address(stock), 2e18, bob, 1e17);
        vm.prank(relayer);
        pool.withdraw("", a1);
        assertEq(stock.balanceOf(relayer), 1e17);
    }

    // ---------------------------------------------------------------- rule: root history (last 100)

    function test_rootHistoryAcceptsLast100Roots() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        bytes32 old = pool.currentRoot();
        uint256 seq = pool.rootSeq(old);
        // 98 more roots: `old` is the 100th most recent root (99 newer ones incl. the empty-root era excluded)
        for (uint256 i; i < 98; ++i) {
            pool.transfer("", _pubT(bytes32(1000 + i * 2), bytes32(1001 + i * 2), address(usdg)), _notes());
        }
        assertEq(pool.rootCount() - seq, 98);
        assertTrue(pool.isKnownRoot(old));
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(5)), bytes32(uint256(6)), address(usdg));
        t.root = old;
        pool.transfer("", t, _notes()); // 99 newer roots now
        assertEq(pool.rootCount() - seq, 99);
        assertTrue(pool.isKnownRoot(old));
        t = _pubT(bytes32(uint256(7)), bytes32(uint256(8)), address(usdg));
        t.root = old;
        pool.transfer("", t, _notes()); // used while still the 100th root, then it ages out
        assertFalse(pool.isKnownRoot(old));
        t = _pubT(bytes32(uint256(9)), bytes32(uint256(10)), address(usdg));
        t.root = old;
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, old));
        pool.transfer("", t, _notes());
    }

    function test_unknownRootRejected() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(uint256(1)), address(usdg), U, bob, 0);
        w.root = bytes32(uint256(12345));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, w.root));
        pool.withdraw("", w);
    }

    // ---------------------------------------------------------------- rule: nullifiers single-use

    function test_nullifierSingleUseAcrossTransferAndWithdraw() public {
        _deposit(alice, address(usdg), 10 * U, 1);
        _insertAll();
        bytes32 n = bytes32(uint256(77));
        pool.transfer("", _pubT(n, bytes32(uint256(78)), address(usdg)), _notes());
        assertTrue(pool.nullifierSpent(n));
        ShieldedPool.PublicWithdraw memory a2 = _pubW(n, address(usdg), U, bob, 0);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, n));
        pool.withdraw("", a2);
        ShieldedPool.PublicTransfer memory a3 = _pubT(bytes32(uint256(1)), n, address(usdg));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, n));
        pool.transfer("", a3, _notes());
    }

    function test_sameNullifierTwiceInOneTransferRejected() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        bytes32 n = bytes32(uint256(5));
        ShieldedPool.PublicTransfer memory a4 = _pubT(n, n, address(usdg));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, n));
        pool.transfer("", a4, _notes());
    }

    /// The verifier reduces public inputs mod p, so n + p would be a second key for the same note.
    function test_nonCanonicalNullifierRejected() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        bytes32 alias_ = bytes32(uint256(5) + P);
        ShieldedPool.PublicWithdraw memory a5 = _pubW(alias_, address(usdg), U, bob, 0);
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.withdraw("", a5);
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(1)), alias_, address(usdg));
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.transfer("", t, _notes());
        t = _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg));
        t.outCommitments[1] = bytes32(P);
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.transfer("", t, _notes());
    }

    // ---------------------------------------------------------------- proofs

    function test_rejectedOrRevertingProofIsInvalid() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        tv.set(false, false);
        ShieldedPool.PublicTransfer memory a6 = _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg));
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer("", a6, _notes());
        tv.set(true, true);
        ShieldedPool.PublicTransfer memory a7 = _pubT(bytes32(uint256(1)), bytes32(uint256(2)), address(usdg));
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer("", a7, _notes());
        wv.set(false, false);
        ShieldedPool.PublicWithdraw memory a8 = _pubW(bytes32(uint256(1)), address(usdg), U, bob, 0);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw("", a8);
        assertFalse(pool.nullifierSpent(bytes32(uint256(1))));
    }

    function test_publicInputsInCircuitOrder() public {
        ExpectVerifier et = new ExpectVerifier();
        ExpectVerifier ew = new ExpectVerifier();
        ShieldedPool p = new ShieldedPool(et, ew, owner, 48 hours);
        bytes32 root = p.currentRoot();

        bytes32[] memory ti = new bytes32[](7);
        (ti[0], ti[1], ti[2], ti[3], ti[4]) = (root, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)), bytes32(uint256(4)));
        ti[5] = bytes32(uint256(uint160(address(usdg))));
        bytes[2] memory notes = _notes();
        ti[6] = bytes32(uint256(keccak256(abi.encode(notes[0], notes[1]))) % Poseidon2.P);
        et.expect_(ti);
        ShieldedPool.PublicTransfer memory t;
        t.root = root;
        t.nullifiers = [bytes32(uint256(1)), bytes32(uint256(2))];
        t.outCommitments = [bytes32(uint256(3)), bytes32(uint256(4))];
        t.asset = address(usdg);
        p.transfer("", t, _notes());

        root = p.currentRoot();
        bytes32[] memory wi = new bytes32[](8);
        (wi[0], wi[1], wi[2], wi[3]) = (root, bytes32(uint256(5)), bytes32(uint256(6)), bytes32(uint256(uint160(address(usdg)))));
        (wi[4], wi[5], wi[6]) = (bytes32(uint256(0)), bytes32(uint256(uint160(bob))), bytes32(uint256(0)));
        wi[7] = bytes32(uint256(keccak256("")) % Poseidon2.P); // encryptedChange is empty here
        ew.expect_(wi);
        ShieldedPool.PublicWithdraw memory w;
        (w.root, w.nullifier, w.changeCommitment, w.asset, w.recipient) =
            (root, bytes32(uint256(5)), bytes32(uint256(6)), address(usdg), bob);
        p.withdraw("", w); // amount 0: nothing moves, change note goes in
        w.nullifier = bytes32(uint256(55));
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        p.withdraw("", w);
    }

    // ---------------------------------------------------------------- withdraw payouts

    function test_withdrawPaysRecipientAndRelayerFeeToSender() public {
        _deposit(alice, address(usdg), 10 * U, 1);
        _insertAll();
        address r = makeAddr("fresh");
        ShieldedPool.PublicWithdraw memory a9 = _pubW(bytes32(uint256(1)), address(usdg), 4 * U, r, U / 10);
        vm.expectEmit(address(pool));
        emit ShieldedPool.Withdrawn(address(usdg), r, 4 * U, U / 10, relayer);
        vm.prank(relayer);
        pool.withdraw("", a9);
        assertEq(usdg.balanceOf(r), 4 * U - U / 10);
        assertEq(usdg.balanceOf(relayer), U / 10);
        assertEq(pool.shielded(address(usdg)), 6 * U);
        assertEq(usdg.balanceOf(address(pool)), 6 * U);
        assertEq(pool.nextLeaf(), 2); // change note inserted
    }

    function test_withdrawRejectsFeeAboveAmountAndZeroRecipient() public {
        _deposit(alice, address(usdg), 10 * U, 1);
        _insertAll();
        ShieldedPool.PublicWithdraw memory a10 = _pubW(bytes32(uint256(1)), address(usdg), U, bob, U + 1);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.withdraw("", a10);
        ShieldedPool.PublicWithdraw memory a11 = _pubW(bytes32(uint256(1)), address(usdg), U, address(0), 0);
        vm.expectRevert(ShieldedPool.ZeroAddress.selector);
        pool.withdraw("", a11);
        ShieldedPool.PublicWithdraw memory a12 = _pubW(bytes32(uint256(1)), address(usdg), uint256(type(uint128).max) + 1, bob, 0);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.withdraw("", a12);
    }

    function test_withdrawMoreThanShieldedRevertsEvenWithAcceptingVerifier() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        ShieldedPool.PublicWithdraw memory a13 = _pubW(bytes32(uint256(1)), address(usdg), 2 * U, bob, 0);
        vm.expectRevert(); // shielded underflow: accounting never lets an asset go negative
        pool.withdraw("", a13);
    }

    // ---------------------------------------------------------------- rule: Stock Tokens in raw units

    function test_multiplierChangeDoesNotTouchNotes() public {
        _deposit(alice, address(stock), 3e18, 1);
        _insertAll();
        stock.setUiMultiplier(2e18); // e.g. a 2:1 split shown in the UI
        assertEq(pool.shielded(address(stock)), 3e18);
        pool.withdraw("", _pubW(bytes32(uint256(1)), address(stock), 3e18, bob, 0));
        assertEq(stock.balanceOf(bob), 10_000_000e18 + 3e18); // the same raw units, not 6e18
        assertEq(pool.shielded(address(stock)), 0);
    }

    // ---------------------------------------------------------------- rule: USDG freeze isolates USDG only

    function test_usdgFreezeBlocksUsdgWithdrawButStockStillExits() public {
        _deposit(alice, address(usdg), 5 * U, 1);
        _deposit(alice, address(stock), 5e18, 2);
        _insertAll();
        usdg.freeze(address(pool));
        bytes32 n = bytes32(uint256(1));
        ShieldedPool.PublicWithdraw memory a14 = _pubW(n, address(usdg), 5 * U, bob, 0);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, address(pool)));
        pool.withdraw("", a14);
        assertFalse(pool.nullifierSpent(n)); // whole tx reverted: the note is still spendable later

        pool.withdraw("", _pubW(bytes32(uint256(2)), address(stock), 5e18, bob, 0));
        assertEq(pool.shielded(address(stock)), 0);
        // private transfers of the frozen asset still work (no token movement)
        pool.transfer("", _pubT(bytes32(uint256(3)), bytes32(uint256(4)), address(usdg)), _notes());

        usdg.unfreeze(address(pool));
        pool.withdraw("", _pubW(n, address(usdg), 5 * U, bob, 0));
    }

    // ---------------------------------------------------------------- fuzz: accounting

    function testFuzz_shieldedEqualsDepositsMinusRefundsMinusWithdrawals(
        uint96 a,
        uint96 b,
        uint96 w,
        bool refundB
    ) public {
        uint256 ra = bound(a, 1, 400_000 * U);
        uint256 rb = bound(b, 1, 400_000 * U);
        _deposit(alice, address(usdg), ra, 1);
        uint256 idb = _deposit(bob, address(usdg), rb, 2);
        if (refundB) {
            vm.prank(bob);
            pool.refundPending(idb);
        }
        _insertAll();
        uint256 inPool = ra + (refundB ? 0 : rb);
        uint256 out = bound(w, 0, inPool);
        uint256 fee = out / 100;
        pool.withdraw("", _pubW(bytes32(uint256(9)), address(usdg), out, makeAddr("r"), fee));
        assertEq(pool.shielded(address(usdg)), inPool - out);
        assertEq(usdg.balanceOf(address(pool)), inPool - out);
        assertEq(usdg.balanceOf(makeAddr("r")), out - fee);
    }

    function testFuzz_rootSequenceMatchesIncrementalTree(uint8 n) public {
        uint256 count = bound(n, 1, 6);
        uint256[] memory leaves = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            vm.prank(alice);
            pool.deposit(address(usdg), U + i, bytes32(i + 1), bytes32(i + 2), "");
            leaves[i] = uint256(pool.pending(i).commitment);
        }
        _insertAll();
        assertEq(uint256(pool.currentRoot()), _root(leaves));
    }

    /// Reference root: full binary tree of depth 20 with HiddenConstants zero subtrees.
    // ------------------------------------------------------------ S8 (security review 2026-10-06)

    function _setNextLeaf(uint256 n) internal {
        stdstore.target(address(pool)).sig("nextLeaf()").checked_write(n);
    }

    /// The tree is full (2^20 leaves). A full withdraw (zero change, commitment 0) still pays out: it needs no leaf.
    function test_S8_fullWithdrawAtAFullTreeNeedsNoLeaf() public {
        _deposit(alice, address(usdg), 1_000 * U, 1);
        _insertAll();
        _setNextLeaf(pool.MAX_LEAVES());
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(uint256(11)), address(usdg), 1_000 * U, bob, 0);
        w.changeCommitment = 0;
        uint256 b = usdg.balanceOf(bob);
        pool.withdraw("", w);
        assertEq(usdg.balanceOf(bob) - b, 1_000 * U);
        assertEq(pool.nextLeaf(), pool.MAX_LEAVES(), "no leaf used");
    }

    /// A partial exit at a full tree starts the next tree; the full tree's final root stays known forever, so
    /// notes in it remain spendable once its roots leave the history.
    function test_S8_fullTreeRollsOverAndItsRootStaysKnown() public {
        _deposit(alice, address(usdg), 1_000 * U, 1);
        _insertAll();
        uint256 max = pool.MAX_LEAVES();
        _setNextLeaf(max - 1);
        vm.recordLogs();
        pool.withdraw("", _pubW(bytes32(uint256(21)), address(usdg), 100 * U, bob, 0)); // fills position max - 1
        bytes32 finalRoot = pool.currentRoot();
        assertTrue(pool.archivedRoot(finalRoot), "full tree's root archived");
        pool.withdraw("", _pubW(bytes32(uint256(22)), address(usdg), 100 * U, bob, 0)); // tree 1, position 0
        assertEq(pool.nextLeaf(), max + 1);
        (uint256 treeId, uint256 pos) = pool.treeOf(max);
        assertEq(treeId, 1);
        assertEq(pos, 0);

        // Far more roots than the history keeps: the archived root is still known, an ordinary old one is not.
        bytes32 oldRoot = finalRoot;
        stdstore.target(address(pool)).sig("rootCount()").checked_write(pool.rootCount() + 10 * pool.ROOT_HISTORY());
        assertTrue(pool.isKnownRoot(oldRoot));
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(uint256(23)), address(usdg), 100 * U, bob, 0);
        w.root = oldRoot;
        pool.withdraw("", w);
    }

    /// Direct deposits can carry a minimum (dust notes cost real money); CrowdBuy deliveries are exempt.
    function test_S8_minDepositAppliesToDirectDeposits() public {
        vm.prank(owner);
        pool.setMinDeposit(address(usdg), 1 * U);
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.deposit(address(usdg), 1 * U - 1, bytes32(uint256(1)), bytes32(uint256(2)), "");
        _deposit(alice, address(usdg), 1 * U, 3);
        vm.prank(crowdAddr);
        pool.depositFor(address(usdg), 1, bytes32(uint256(4)), bytes32(uint256(5)), "", alice);
        vm.prank(alice);
        vm.expectRevert();
        pool.setMinDeposit(address(usdg), 0);
    }

    function _root(uint256[] memory leaves) internal pure returns (uint256) {
        uint256[] memory level = leaves;
        for (uint256 d; d < 20; ++d) {
            uint256 w = (level.length + 1) / 2;
            uint256[] memory next = new uint256[](w);
            for (uint256 i; i < w; ++i) {
                uint256 l = level[2 * i];
                uint256 r = 2 * i + 1 < level.length ? level[2 * i + 1] : HiddenConstants.zeros(d);
                next[i] = Poseidon2.hash2(l, r);
            }
            level = next;
        }
        return level[0];
    }
}
