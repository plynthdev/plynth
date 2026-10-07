// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {ThresholdVerifier} from "../../src/consumer/ThresholdVerifier.sol";
import {TransferVerifier} from "../../src/consumer/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../../src/consumer/verifiers/WithdrawVerifier.sol";
import {ThresholdHoldingsVerifier} from "../../src/consumer/verifiers/ThresholdHoldingsVerifier.sol";
import {ThresholdSavingsVerifier} from "../../src/consumer/verifiers/ThresholdSavingsVerifier.sol";
import {HiddenConstants} from "../../src/consumer/verifiers/HiddenConstants.sol";
import {Poseidon2} from "../../src/consumer/verifiers/Poseidon2.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {ThresholdProofs} from "../../script/ThresholdProofs.s.sol";

/// ThresholdVerifier with the real UltraHonk verifiers and proofs made by the SDK
/// (sdk/scripts/threshold-fixtures.ts). The pool history below reproduces the fixture's trees exactly.
contract ThresholdVerifierTest is Test {
    ShieldedPool pool;
    ThresholdVerifier tv;
    MockUSDG token;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    string json;
    address asset;
    address verifierA;
    address verifierB;
    bytes32 requestId;

    function setUp() public {
        vm.chainId(31337);
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/consumer/fixtures/threshold.json"));
        asset = vm.parseJsonAddress(json, ".asset");
        verifierA = vm.parseJsonAddress(json, ".verifierA");
        verifierB = vm.parseJsonAddress(json, ".verifierB");
        requestId = bytes32(vm.parseJsonUint(json, ".requestId"));
        deployCodeTo("MockUSDG.sol:MockUSDG", asset);
        token = MockUSDG(asset);
        pool = new ShieldedPool(
            IHonkVerifier(address(new TransferVerifier())), IHonkVerifier(address(new WithdrawVerifier())), owner, 48 hours
        );
        address tvAt = vm.parseJsonAddress(json, ".tv");
        deployCodeTo(
            "ThresholdVerifier.sol:ThresholdVerifier",
            abi.encode(pool, new ThresholdHoldingsVerifier(), new ThresholdSavingsVerifier()),
            tvAt
        );
        tv = ThresholdVerifier(tvAt);

        vm.prank(owner);
        pool.proposeCap(asset, 10e12);
        vm.warp(block.timestamp + 48 hours);
        pool.applyCap(asset);
        vm.startPrank(token.owner());
        token.mint(alice, 10e6);
        token.mint(bob, 10e6);
        vm.stopPrank();
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        token.approve(address(pool), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _b(string memory key) internal view returns (bytes32) {
        return bytes32(vm.parseJsonUint(json, key));
    }

    function _hex(string memory key) internal view returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }

    function _deposit(uint256 i) internal {
        string memory k = string.concat(".deposits[", vm.toString(i), "]");
        address who = keccak256(bytes(vm.parseJsonString(json, string.concat(k, ".who")))) == keccak256("alice")
            ? alice
            : bob;
        vm.prank(who);
        pool.deposit(asset, _u(string.concat(k, ".raw")), _b(string.concat(k, ".ownerPk")), _b(string.concat(k, ".blinding")), "");
    }

    function _insertAll() internal {
        vm.warp(block.timestamp + 1 hours + 1);
        pool.insertPending(100);
    }

    /// The fixture's history: deposit 0, sync (rootFrom); deposit 1, a refunded 999 deposit, deposits 2 and 3, sync.
    function _history() internal {
        _deposit(0);
        _insertAll();
        tv.syncDeposits(100);
        assertEq(tv.depositRoot(), _b(".depositRootFrom"), "rootFrom");

        _deposit(1);
        vm.prank(alice);
        uint256 refundId = pool.deposit(asset, 999, _b(".deposits[0].ownerPk"), bytes32(uint256(0xdead)), "");
        vm.prank(alice);
        pool.refundPending(refundId);
        _deposit(2);
        _deposit(3);
        _insertAll();
        vm.roll(block.number + 5);
        tv.syncDeposits(100);
        assertEq(tv.depositRoot(), _b(".depositRootTo"), "rootTo");
        assertEq(pool.currentRoot(), _b(".poolRoot"), "pool root");
    }

    function _holdings() internal view returns (ThresholdVerifier.HoldingsClaim memory c) {
        c.root = _b(".holdings.root");
        c.asset = asset;
        c.threshold = _u(".holdings.threshold");
        for (uint256 i; i < 8; ++i) {
            c.nullifiers[i] = _b(string.concat(".holdings.nullifiers[", vm.toString(i), "]"));
        }
    }

    function _savings() internal view returns (ThresholdVerifier.SavingsClaim memory c) {
        c.rootFrom = _b(".savings.rootFrom");
        c.rootTo = _b(".savings.rootTo");
        c.asset = asset;
        c.threshold = _u(".savings.threshold");
    }

    function _withdrawNote3() internal {
        ShieldedPool.PublicWithdraw memory w = ShieldedPool.PublicWithdraw({
            root: _b(".withdraw.root"),
            nullifier: _b(".withdraw.nullifier"),
            changeCommitment: _b(".withdraw.changeCommitment"),
            asset: asset,
            amount: _u(".withdraw.amount"),
            recipient: vm.parseJsonAddress(json, ".recipient"),
            relayerFee: 0,
            encryptedChange: _hex(".withdraw.encryptedChangeHex") // bound by the proof (ext_hash)
        });
        pool.withdraw(_hex(".withdraw.proofHex"), w);
    }

    // ---------------------------------------------------------------- nonces

    function test_nonceMatchesSdk() public view {
        assertEq(uint256(tv.nonceFor(verifierA, requestId)), _u(".nonceA"));
    }

    function testFuzz_nonceIsAFieldElementAndPerVerifier(address v1, address v2, bytes32 r1, bytes32 r2) public view {
        uint256 n1 = uint256(tv.nonceFor(v1, r1));
        assertLt(n1, Poseidon2.P);
        if (v1 != v2 || r1 != r2) assertTrue(n1 != uint256(tv.nonceFor(v2, r2)));
    }

    function test_nonceDependsOnChain() public {
        bytes32 n = tv.nonceFor(verifierA, requestId);
        vm.chainId(46630);
        assertTrue(tv.nonceFor(verifierA, requestId) != n);
    }

    // ---------------------------------------------------------------- holdings

    function test_holdings_trueStatementVerifies() public {
        _history();
        ThresholdVerifier.HoldingsResult memory r =
            tv.checkHoldings(_hex(".holdings.proofHex"), _holdings(), verifierA, requestId);
        assertEq(r.notes, 2, "two real notes (300_000 + 200_000)");
        assertEq(r.poolRootSeq, pool.rootSeq(_b(".poolRoot")));
        assertTrue(tv.verifyHoldings(_hex(".holdings.proofHex"), _holdings(), verifierA, requestId));
    }

    function test_holdings_olderRootStillAcceptedWhileUnspent() public {
        _history();
        _deposit(0); // new deposit -> new current root; the proof's root is now historical
        _insertAll();
        assertTrue(pool.currentRoot() != _b(".poolRoot"));
        tv.checkHoldings(_hex(".holdings.proofHex"), _holdings(), verifierA, requestId);
    }

    function test_holdings_proofForVerifierARejectedByB() public {
        _history();
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), _holdings(), verifierB, requestId);
        assertFalse(tv.verifyHoldings(_hex(".holdings.proofHex"), _holdings(), verifierB, requestId));
    }

    function test_holdings_otherRequestOfSameVerifierRejected() public {
        _history();
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), _holdings(), verifierA, keccak256("another request"));
    }

    function test_holdings_spentNoteRejected() public {
        _history();
        _withdrawNote3();
        bytes32 n = _b(".withdraw.nullifier");
        // the withdrawn note is one of the counted notes
        bool counted;
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        for (uint256 i; i < 8; ++i) {
            if (c.nullifiers[i] == n) counted = true;
        }
        assertTrue(counted);
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.NullifierSpent.selector, n));
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
        assertFalse(tv.verifyHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId));
    }

    function test_holdings_hidingASpentNullifierBreaksTheProof() public {
        _history();
        _withdrawNote3();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        for (uint256 i; i < 8; ++i) {
            if (c.nullifiers[i] == _b(".withdraw.nullifier")) c.nullifiers[i] = 0;
        }
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_raisedThresholdRejected() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.threshold += 1;
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_otherAssetRejected() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.asset = address(0xBEEF);
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_unknownRoot() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.root = bytes32(uint256(c.root) + 1);
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.UnknownRoot.selector, c.root));
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_rootNotYetPublished() public {
        // Before the deposits are inserted the proof's root does not exist on-chain.
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.UnknownRoot.selector, _b(".holdings.root")));
        tv.checkHoldings(_hex(".holdings.proofHex"), _holdings(), verifierA, requestId);
    }

    function test_holdings_nonCanonicalNullifierRejected() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.nullifiers[0] = bytes32(uint256(c.nullifiers[0]) + Poseidon2.P);
        vm.expectRevert(ThresholdVerifier.NotAFieldElement.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_duplicateNullifierRejected() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.nullifiers[1] = c.nullifiers[0];
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.DuplicateNullifier.selector, c.nullifiers[0]));
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    function test_holdings_tamperedProofRejected() public {
        _history();
        bytes memory proof = _hex(".holdings.proofHex");
        proof[100] ^= 0x01;
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkHoldings(proof, _holdings(), verifierA, requestId);
    }

    function test_holdings_badThresholdAndAsset() public {
        _history();
        ThresholdVerifier.HoldingsClaim memory c = _holdings();
        c.threshold = uint256(type(uint128).max) + 1;
        vm.expectRevert(ThresholdVerifier.BadThreshold.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
        c = _holdings();
        c.asset = address(0);
        vm.expectRevert(ThresholdVerifier.ZeroAddress.selector);
        tv.checkHoldings(_hex(".holdings.proofHex"), c, verifierA, requestId);
    }

    // ---------------------------------------------------------------- savings

    function test_savings_trueStatementVerifies() public {
        _history();
        (ThresholdVerifier.DepositRoot memory from, ThresholdVerifier.DepositRoot memory to) =
            tv.checkSavings(_hex(".savings.proofHex"), _savings(), verifierA, requestId);
        assertEq(from.size, 1);
        assertEq(to.size, 4);
        assertLt(from.seq, to.seq);
        assertLt(from.blockNumber, to.blockNumber);
        assertTrue(tv.verifySavings(_hex(".savings.proofHex"), _savings(), verifierA, requestId));
    }

    function test_savings_stillValidAfterTheNotesAreSpent() public {
        // Savings history counts deposits made, not current holdings.
        _history();
        _withdrawNote3();
        tv.checkSavings(_hex(".savings.proofHex"), _savings(), verifierA, requestId);
    }

    function test_savings_proofForVerifierARejectedByB() public {
        _history();
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkSavings(_hex(".savings.proofHex"), _savings(), verifierB, requestId);
        assertFalse(tv.verifySavings(_hex(".savings.proofHex"), _savings(), verifierB, requestId));
    }

    function test_savings_raisedThresholdRejected() public {
        _history();
        ThresholdVerifier.SavingsClaim memory c = _savings();
        c.threshold += 1;
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkSavings(_hex(".savings.proofHex"), c, verifierA, requestId);
    }

    function test_savings_widerWindowClaimRejected() public {
        // Claiming the window started at the empty tree (a different public input) breaks the proof.
        _history();
        ThresholdVerifier.SavingsClaim memory c = _savings();
        c.rootFrom = bytes32(HiddenConstants.EMPTY_ROOT);
        vm.expectRevert(ThresholdVerifier.InvalidProof.selector);
        tv.checkSavings(_hex(".savings.proofHex"), c, verifierA, requestId);
    }

    function test_savings_unknownRootsAndSwappedWindow() public {
        _history();
        ThresholdVerifier.SavingsClaim memory c = _savings();
        c.rootTo = _b(".poolRoot") ^ bytes32(uint256(1));
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.UnknownDepositRoot.selector, c.rootTo));
        tv.checkSavings(_hex(".savings.proofHex"), c, verifierA, requestId);
        c = _savings();
        (c.rootFrom, c.rootTo) = (c.rootTo, c.rootFrom);
        vm.expectRevert(ThresholdVerifier.BadWindow.selector);
        tv.checkSavings(_hex(".savings.proofHex"), c, verifierA, requestId);
    }

    function test_savings_poolRootIsNotADepositRootUnlessSynced() public {
        // Before the second sync, rootTo is unknown to the deposit tree even though the pool has it.
        _deposit(0);
        _insertAll();
        tv.syncDeposits(100);
        _deposit(1);
        _deposit(2);
        _deposit(3);
        _insertAll();
        vm.expectRevert(abi.encodeWithSelector(ThresholdVerifier.UnknownDepositRoot.selector, _b(".savings.rootTo")));
        tv.checkSavings(_hex(".savings.proofHex"), _savings(), verifierA, requestId);
    }

    // ---------------------------------------------------------------- deposit tree

    function test_sync_skipsRefundsAndNeverTakesTransferOrChangeLeaves() public {
        _history();
        assertEq(tv.depositCount(), 4);
        assertEq(tv.nextPendingSynced(), 5, "refunded pending id 2 stepped over");
        _withdrawNote3(); // a full withdraw: zero change inserts no leaf (S8)
        assertEq(pool.nextLeaf(), 4);
        vm.expectRevert(ThresholdVerifier.NothingToSync.selector);
        tv.syncDeposits(100);
        assertEq(tv.depositCount(), 4);
    }

    function test_sync_waitsForInsertion() public {
        _deposit(0);
        assertEq(tv.unsyncedDeposits(), 0);
        vm.expectRevert(ThresholdVerifier.NothingToSync.selector);
        tv.syncDeposits(100); // queued, not inserted: not final yet
        _insertAll();
        assertEq(tv.unsyncedDeposits(), 1);
        assertEq(tv.syncDeposits(100), 1);
        assertEq(tv.depositRoot(), _b(".depositRootFrom"));
    }

    function test_sync_inBatchesMatchesOneShot() public {
        for (uint256 i; i < 4; ++i) {
            _deposit(i);
        }
        _insertAll();
        for (uint256 i; i < 4; ++i) {
            assertEq(tv.syncDeposits(1), 1);
        }
        assertEq(tv.depositRoot(), _b(".depositRootTo"));
        ThresholdVerifier.DepositRoot memory r = tv.depositRootInfo(tv.depositRoot());
        assertEq(r.seq, 5); // empty root + 4 batches
        assertEq(r.size, 4);
    }

    function test_sync_onlyRefundsAdvancesCursorWithoutNewRoot() public {
        vm.prank(alice);
        pool.deposit(asset, 5, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.prank(alice);
        pool.refundPending(0);
        _deposit(0);
        _insertAll();
        assertEq(tv.syncDeposits(1), 0);
        assertEq(tv.depositRootCount(), 1);
        assertEq(tv.nextPendingSynced(), 1);
        assertEq(tv.syncDeposits(1), 1);
        assertEq(tv.depositRoot(), _b(".depositRootFrom"));
    }

    function test_emptyRootPublishedAtDeploy() public view {
        assertEq(tv.depositRoot(), bytes32(HiddenConstants.EMPTY_ROOT));
        ThresholdVerifier.DepositRoot memory r = tv.depositRootInfo(bytes32(HiddenConstants.EMPTY_ROOT));
        assertEq(r.seq, 1);
        assertEq(r.size, 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(ThresholdVerifier.ZeroAddress.selector);
        new ThresholdVerifier(ShieldedPool(address(0)), IHonkVerifier(address(1)), IHonkVerifier(address(1)));
        vm.expectRevert(ThresholdVerifier.ZeroAddress.selector);
        new ThresholdVerifier(pool, IHonkVerifier(address(0)), IHonkVerifier(address(1)));
    }

    function test_deployScriptWiresVerifiers() public {
        ThresholdVerifier t = new ThresholdProofs().deploy(pool);
        assertEq(address(t.pool()), address(pool));
        assertTrue(address(t.holdingsVerifier()).code.length > 0);
        assertTrue(address(t.savingsVerifier()).code.length > 0);
        assertEq(t.TREE_DEPTH(), HiddenConstants.TREE_DEPTH);
    }
}
