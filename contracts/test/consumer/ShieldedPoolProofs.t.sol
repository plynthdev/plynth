// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {TransferVerifier} from "../../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../../src/consumer/verifiers/WithdrawVerifier.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// ShieldedPool with the real UltraHonk verifiers and proofs made by the SDK (sdk/scripts/pool-fixtures.ts):
/// alice deposits 1_000_000 + 250_000, transfers 900_000 to bob (350_000 change), bob withdraws 600_000 to
/// RECIPIENT through a relayer that keeps a 1_000 fee (the proof binds that relayer, audit L-9). The on-chain tree
/// must reproduce the SDK's roots.
contract ShieldedPoolProofsTest is Test {
    ShieldedPool pool;
    MockUSDG token;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address relayer; // the fixture's RELAYER: the only address that may submit the fee-paying withdraw
    string json;
    address asset;
    address recipient;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/shielded_pool.json"));
        asset = vm.parseJsonAddress(json, ".asset");
        recipient = vm.parseJsonAddress(json, ".recipient");
        relayer = vm.parseJsonAddress(json, ".relayer");
        deployCodeTo("MockUSDG.sol:MockUSDG", asset);
        token = MockUSDG(asset);
        pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), owner, 48 hours
        );
        vm.prank(owner);
        pool.proposeCap(asset, 10e12);
        vm.warp(block.timestamp + 48 hours);
        pool.applyCap(asset);

        vm.prank(token.owner());
        token.mint(alice, 10e6);
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _b(string memory key) internal view returns (bytes32) {
        return bytes32(vm.parseJsonUint(json, key));
    }

    function _hex(string memory key) internal view returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }

    function _depositAndInsert() internal {
        bytes32 ownerPk = _b(".aliceOwnerPk");
        vm.startPrank(alice);
        pool.deposit(asset, _u(".deposits[0].raw"), ownerPk, _b(".deposits[0].blinding"), "");
        pool.deposit(asset, _u(".deposits[1].raw"), ownerPk, _b(".deposits[1].blinding"), "");
        vm.stopPrank();
        assertEq(pool.pending(0).commitment, _b(".depositCommitments[0]"), "on-chain commitment == SDK commitment");
        assertEq(pool.pending(1).commitment, _b(".depositCommitments[1]"));
        vm.warp(block.timestamp + 2 hours); // MIN_PENDING_DELAY + SOLO_INSERT_DELAY: a batch of two
        pool.insertPending(10);
        assertEq(pool.currentRoot(), _b(".rootAfterDeposits"), "on-chain root == SDK root");
    }

    function _transferPub() internal view returns (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) {
        t.root = _b(".transfer.root");
        t.nullifiers = [_b(".transfer.nullifiers[0]"), _b(".transfer.nullifiers[1]")];
        t.outCommitments = [_b(".transfer.outCommitments[0]"), _b(".transfer.outCommitments[1]")];
        t.asset = asset;
        e[0] = _hex(".transfer.encryptedNotesHex[0]");
        e[1] = _hex(".transfer.encryptedNotesHex[1]");
    }

    function _withdrawPub() internal view returns (ShieldedPool.PublicWithdraw memory w) {
        w.root = _b(".withdraw.root");
        w.nullifier = _b(".withdraw.nullifier");
        w.changeCommitment = _b(".withdraw.changeCommitment");
        w.asset = asset;
        w.amount = _u(".withdraw.amount");
        w.recipient = recipient;
        w.relayerFee = _u(".withdraw.relayerFee");
        w.encryptedChange = _hex(".withdraw.encryptedChangeHex");
    }

    function test_fullFlowWithRealProofs() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        uint256 g = gasleft();
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        console2.log("transfer gas (verify + 2 inserts)", g - gasleft());
        assertEq(pool.currentRoot(), _b(".rootAfterTransfer"));

        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        g = gasleft();
        vm.prank(relayer);
        pool.withdraw(_hex(".withdraw.proofHex"), w);
        console2.log("withdraw gas (verify + 1 insert + 2 transfers)", g - gasleft());
        assertEq(pool.currentRoot(), _b(".rootAfterWithdraw"));
        assertEq(token.balanceOf(recipient), 599_000);
        assertEq(token.balanceOf(relayer), 1_000);
        assertEq(token.balanceOf(address(pool)), 650_000);
        assertEq(pool.shielded(asset), 650_000);
    }

    function test_realTransferReplayRejected() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        bytes memory proof = _hex(".transfer.proofHex");
        pool.transfer(proof, t, e);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, t.nullifiers[0]));
        pool.transfer(proof, t, e);
    }

    function test_realTransferWithSwappedOutputsRejected() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        (t.outCommitments[0], t.outCommitments[1]) = (t.outCommitments[1], t.outCommitments[0]);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(_hex(".transfer.proofHex"), t, e);
    }

    /// A front-runner cannot redirect a relayed withdraw: recipient, fee and amount are bound by the proof.
    function test_realWithdrawBindsRecipientFeeAndAmount() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        bytes memory proof = _hex(".withdraw.proofHex");

        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        w.recipient = makeAddr("thief");
        vm.prank(relayer); // even the bound relayer
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(proof, w);
        w = _withdrawPub();
        w.relayerFee = 2_000;
        vm.prank(relayer); // even the bound relayer
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(proof, w);
        w = _withdrawPub();
        w.amount = 700_000;
        vm.prank(relayer); // even the bound relayer
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(proof, w);

        // the bound relayer submitting the honest values (including the encrypted change, bound too) succeeds
        w = _withdrawPub();
        vm.prank(relayer);
        pool.withdraw(proof, w);
        assertEq(token.balanceOf(recipient), 599_000);
    }

    function test_realWithdrawBeforeTransferHasUnknownRoot() public {
        _depositAndInsert();
        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, w.root));
        pool.withdraw(_hex(".withdraw.proofHex"), w);
    }

    // ------------------------------------------------------------ S7 (security review 2026-10-06)

    /// A relayer that swaps the encrypted change (the only copy of the change note's blinding) would leave the
    /// change note unspendable forever. The ciphertext is bound by the proof, so the swap is refused.
    function test_S7_relayerCannotReplaceTheEncryptedChange() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        bytes memory proof = _hex(".withdraw.proofHex");
        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        w.encryptedChange = hex"00";
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(proof, w);
        assertFalse(pool.nullifierSpent(w.nullifier));
        vm.prank(relayer);
        pool.withdraw(proof, _withdrawPub());
    }

    /// The same for a transfer's two output notes (a recipient could otherwise never find a payment).
    function test_S7_relayerCannotReplaceTransferNotes() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        bytes memory proof = _hex(".transfer.proofHex");
        bytes[2] memory junk = [e[0], bytes(hex"00")];
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(proof, t, junk);
        junk = [e[1], e[0]];
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(proof, t, junk);
        pool.transfer(proof, t, e);
    }

    // ------------------------------------------------------------ M-5 (external audit 2026-10): roots never expire

    /// `n` tiny deposits funded by `from`, then inserted one per insertPending call by a stranger: n new roots.
    function _churnRoots(address from, uint256 n) internal {
        vm.prank(token.owner());
        token.mint(from, n);
        vm.startPrank(from);
        token.approve(address(pool), n);
        for (uint256 i; i < n; ++i) {
            pool.deposit(asset, 1, bytes32(i + 1), bytes32(i + 1000), "");
        }
        vm.stopPrank();
        vm.warp(block.timestamp + 2 hours + 1); // past every insert delay, so one-entry inserts are allowed
        vm.startPrank(makeAddr("mallory"));
        for (uint256 i; i < n; ++i) {
            pool.insertPending(1);
        }
        vm.stopPrank();
    }

    /// Variant 1: the attacker's own (refundable) deposits push 101 roots in front of a relayed withdraw proven
    /// against an older root. The proof must still verify and pay out.
    function test_M5_inFlightWithdrawSurvivesRootChurnFromOwnDeposits() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        uint256 seq = pool.rootSeq(w.root);
        _churnRoots(makeAddr("mallory"), 101);
        assertGt(pool.rootCount() - seq, 100, "more newer roots than the old history kept");
        assertTrue(pool.isKnownRoot(w.root));
        vm.prank(relayer);
        pool.withdraw(_hex(".withdraw.proofHex"), w);
        assertEq(token.balanceOf(recipient), 599_000);
        assertEq(token.balanceOf(relayer), 1_000);
    }

    /// Variant 2: other people's pending deposits, inserted one at a time by a stranger, push 101 roots in front
    /// of a transfer proven against the root after alice's deposits.
    function test_M5_inFlightTransferSurvivesRootChurnFromOthersDeposits() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        uint256 seq = pool.rootSeq(t.root);
        _churnRoots(makeAddr("savers"), 101);
        assertGt(pool.rootCount() - seq, 100);
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        assertTrue(pool.nullifierSpent(t.nullifiers[0]));
        assertTrue(pool.nullifierSpent(t.nullifiers[1]));
    }

    // ------------------------------------------------------------ L-9 (external audit 2026-10): fee bound to relayer

    /// A copier who front-runs the relayer with the same calldata used to take the fee. The proof now binds the
    /// relayer (ext hash includes msg.sender when relayerFee != 0): the copy fails, the bound relayer is paid.
    function test_L9_copiedWithdrawCannotTakeTheRelayerFee() public {
        _depositAndInsert();
        (ShieldedPool.PublicTransfer memory t, bytes[2] memory e) = _transferPub();
        pool.transfer(_hex(".transfer.proofHex"), t, e);
        bytes memory proof = _hex(".withdraw.proofHex");
        ShieldedPool.PublicWithdraw memory w = _withdrawPub();
        address copier = makeAddr("copier");
        vm.prank(copier);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(proof, w);
        assertEq(token.balanceOf(copier), 0);
        assertFalse(pool.nullifierSpent(w.nullifier));
        vm.prank(relayer);
        pool.withdraw(proof, w);
        assertEq(token.balanceOf(relayer), 1_000);
        assertEq(token.balanceOf(recipient), 599_000);
    }
}
