// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {ShieldedPool, IHonkVerifier} from "../../src/consumer/ShieldedPool.sol";
import {ShieldedPoolBase} from "./ShieldedPoolBase.sol";

/// Token whose transfers deliver `amount - 1` (fee) or `amount + 1` (bonus) to the receiver.
contract SkewToken is ERC20 {
    bool public immutable bonus;

    constructor(bool bonus_) ERC20("Skew", "SKW") {
        bonus = bonus_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(0) || to == address(0) || value == 0) return;
        if (bonus) super._update(address(0), to, 1);
        else super._update(to, address(0), 1);
    }
}

/// Tests that close gaps found by mutation testing (contracts/mutation/REPORT.md). Reverts from `new` are
/// checked with try/catch, not vm.expectRevert: with dynamic test linking a `vm.expectRevert(); new X()` ends
/// the test at that revert.
contract ShieldedPoolMutationTest is ShieldedPoolBase {
    using stdStorage for StdStorage;

    bytes4 internal immutable ZERO_ADDRESS = ShieldedPool.ZeroAddress.selector;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        pool.setTrade(address(this)); // this test contract plays the ShieldedTrade module
    }

    function _deployReason(IHonkVerifier t, IHonkVerifier w, uint64 delay) internal returns (bytes4 reason) {
        try new ShieldedPool(t, w, owner, delay) returns (ShieldedPool) {
            return bytes4(0);
        } catch (bytes memory err) {
            return bytes4(err);
        }
    }

    // ---------------------------------------------------------------- constructor and owner setters

    function test_constructorRejectsEachZeroVerifier() public {
        assertEq(_deployReason(IHonkVerifier(address(0)), wv, 48 hours), ZERO_ADDRESS);
        assertEq(_deployReason(tv, IHonkVerifier(address(0)), 48 hours), ZERO_ADDRESS);
    }

    function test_capDelayMinimumIsInclusive() public {
        assertEq(_deployReason(tv, wv, 10 minutes - 1), ShieldedPool.DelayTooShort.selector);
        assertEq(_deployReason(tv, wv, 10 minutes), bytes4(0));
    }

    function test_setTradeRejectsZero() public {
        ShieldedPool p = new ShieldedPool(tv, wv, owner, 48 hours);
        vm.prank(owner);
        vm.expectRevert(ZERO_ADDRESS);
        p.setTrade(address(0));
    }

    function test_setMinDepositAndProposeCapRejectZeroAsset() public {
        vm.startPrank(owner);
        vm.expectRevert(ZERO_ADDRESS);
        pool.setMinDeposit(address(0), 1);
        vm.expectRevert(ZERO_ADDRESS);
        pool.proposeCap(address(0), 1);
        vm.stopPrank();
    }

    function test_proposeCapEqualToCurrentAppliesNowAndClearsProposal() public {
        vm.startPrank(owner);
        pool.proposeCap(address(usdg), capUsdg * 2); // a pending raise
        pool.proposeCap(address(usdg), capUsdg); // equal to the current cap: immediate, cancels the raise
        vm.stopPrank();
        (, uint64 eta) = pool.capProposal(address(usdg));
        assertEq(eta, 0);
        assertEq(pool.cap(address(usdg)), capUsdg);
    }

    function test_applyCapWorksAfterEtaNotOnlyAtIt() public {
        vm.prank(owner);
        pool.proposeCap(address(usdg), capUsdg * 2);
        (, uint64 eta) = pool.capProposal(address(usdg));
        vm.warp(uint256(eta) + 1 days);
        pool.applyCap(address(usdg));
        assertEq(pool.cap(address(usdg)), capUsdg * 2);
    }

    // ---------------------------------------------------------------- deposits and the pending queue

    function test_depositAcceptsExactlyMaxRawAndTopFieldElement() public {
        uint256 max = pool.MAX_RAW();
        vm.prank(alice);
        pool.deposit(address(usdg), U, bytes32(P - 1), bytes32(P - 1), ""); // P - 1 is a field element
        assertEq(pool.pendingCount(), 1);

        // MAX_RAW (2^128 - 1) is the largest accepted amount.
        ERC20Plain plain = new ERC20Plain();
        _raiseCap(address(plain), max);
        plain.mint(alice, max);
        vm.startPrank(alice);
        plain.approve(address(pool), max);
        pool.deposit(address(plain), max, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.stopPrank();
        assertEq(pool.shielded(address(plain)), max);
        assertEq(pool.pendingCount(), 2);
    }

    function test_depositRejectsSkewedTransfers() public {
        SkewToken fee = new SkewToken(false);
        SkewToken bonus = new SkewToken(true);
        _raiseCap(address(fee), 1e30);
        _raiseCap(address(bonus), 1e30);
        fee.mint(alice, 1e24);
        bonus.mint(alice, 1e24);
        vm.startPrank(alice);
        fee.approve(address(pool), type(uint256).max);
        bonus.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 1e18 - 1, 1e18));
        pool.deposit(address(fee), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 1e18 + 1, 1e18));
        pool.deposit(address(bonus), 1e18, bytes32(uint256(1)), bytes32(uint256(2)), "");
        vm.stopPrank();
    }

    function test_refundPendingOutOfRangeIsNotPending() public {
        _deposit(alice, address(usdg), U, 1);
        uint256 n = pool.pendingCount();
        assertEq(n, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotPending.selector, n));
        pool.refundPending(n);
    }

    function test_insertPendingAndReadyCountLongAfterTheDelay() public {
        _deposit(alice, address(usdg), U, 1);
        vm.warp(block.timestamp + pool.MIN_PENDING_DELAY() + 3 hours);
        assertEq(pool.readyCount(10), 1);
        assertEq(pool.insertPending(10), 1);
        assertEq(pool.nextLeaf(), 1);
    }

    function test_readyCountHonoursLimit() public {
        for (uint256 i; i < 3; ++i) _deposit(alice, address(usdg), U, i + 1);
        vm.warp(block.timestamp + pool.MIN_PENDING_DELAY());
        assertEq(pool.readyCount(2), 2);
        assertEq(pool.readyCount(10), 3);
    }

    function test_insertPendingOverOnlyRefundedEntriesPublishesNoRoot() public {
        uint256 id = _deposit(alice, address(usdg), U, 1);
        vm.prank(alice);
        pool.refundPending(id);
        uint256 rc = pool.rootCount();
        bytes32 root = pool.currentRoot();
        vm.warp(block.timestamp + pool.MIN_PENDING_DELAY());
        assertEq(pool.insertPending(10), 0);
        assertEq(pool.nextPending(), 1);
        assertEq(pool.rootCount(), rc, "no root published for an empty batch");
        assertEq(pool.currentRoot(), root);
    }

    // ---------------------------------------------------------------- tree views and rollover

    function test_treeOfSplitsTreeAndPosition() public view {
        uint256 max = pool.MAX_LEAVES();
        (uint256 t, uint256 p) = pool.treeOf(5);
        assertEq(t, 0);
        assertEq(p, 5);
        (t, p) = pool.treeOf(2 * max + 7);
        assertEq(t, 2);
        assertEq(p, 7);
    }

    function test_treeArchivedEventNamesTheFullTree() public {
        _deposit(alice, address(usdg), 1_000 * U, 1);
        _insertAll();
        stdstore.target(address(pool)).sig("nextLeaf()").checked_write(pool.MAX_LEAVES() - 1);
        vm.expectEmit(true, false, false, false, address(pool));
        emit ShieldedPool.TreeArchived(0, bytes32(0));
        pool.withdraw("", _pubW(bytes32(uint256(31)), address(usdg), 100 * U, bob, 0));
    }

    // ---------------------------------------------------------------- spends

    function test_transferRejectsZeroAsset() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(41)), bytes32(uint256(42)), address(0));
        vm.expectRevert(ZERO_ADDRESS);
        pool.transfer("", t, _notes());
    }

    /// P is not a field element. Nullifiers are never hashed on-chain, so the pool's own check is the only one
    /// (an output or leaf equal to P is also refused by Poseidon2, with the same error).
    function test_nullifierEqualToPRejected() public {
        _deposit(alice, address(usdg), 1_000 * U, 1);
        _insertAll();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(P), bytes32(uint256(82)), address(usdg));
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.transfer("", t, _notes());
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(P), address(usdg), U, bob, 0);
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.withdraw("", w);
    }

    function test_transferWithOneZeroOutputInsertsOneLeaf() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        uint256 leaves = pool.nextLeaf();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(51)), bytes32(uint256(52)), address(usdg));
        t.outCommitments[1] = 0;
        pool.transfer("", t, _notes());
        assertEq(pool.nextLeaf(), leaves + 1);
    }

    function test_transferWithNoOutputsPublishesNoRoot() public {
        _deposit(alice, address(usdg), U, 1);
        _insertAll();
        uint256 rc = pool.rootCount();
        ShieldedPool.PublicTransfer memory t = _pubT(bytes32(uint256(61)), bytes32(uint256(62)), address(usdg));
        t.outCommitments[0] = 0;
        t.outCommitments[1] = 0;
        pool.transfer("", t, _notes());
        assertEq(pool.rootCount(), rc);
        assertFalse(pool.isKnownRoot(bytes32(0)), "the zero root never becomes known");
    }

    function test_withdrawAcceptsChangeNoteOfExactlyMaxBytes() public {
        _deposit(alice, address(usdg), 1_000 * U, 1);
        _insertAll();
        ShieldedPool.PublicWithdraw memory w = _pubW(bytes32(uint256(71)), address(usdg), 100 * U, bob, 0);
        w.encryptedChange = new bytes(pool.MAX_NOTE_BYTES());
        pool.withdraw("", w);
        w = _pubW(bytes32(uint256(72)), address(usdg), 100 * U, bob, 0);
        w.encryptedChange = new bytes(pool.MAX_NOTE_BYTES() + 1);
        vm.expectRevert(ShieldedPool.NoteTooLarge.selector);
        pool.withdraw("", w);
    }

    // ---------------------------------------------------------------- ShieldedTrade hooks

    function test_tradeCreditCapIsInclusive() public {
        usdg.mint(address(this), capUsdg + 1);
        usdg.approve(address(pool), type(uint256).max);
        pool.tradeCredit(address(usdg), capUsdg, true);
        assertEq(pool.shielded(address(usdg)), capUsdg);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.CapExceeded.selector, capUsdg, 1, capUsdg));
        pool.tradeCredit(address(usdg), 1, true);
    }

    function test_tradeCreditRejectsSkewedTransfers() public {
        SkewToken fee = new SkewToken(false);
        SkewToken bonus = new SkewToken(true);
        fee.mint(address(this), 1e24);
        bonus.mint(address(this), 1e24);
        fee.approve(address(pool), type(uint256).max);
        bonus.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 1e18 - 1, 1e18));
        pool.tradeCredit(address(fee), 1e18, false);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.TransferAmountMismatch.selector, 1e18 + 1, 1e18));
        pool.tradeCredit(address(bonus), 1e18, false);
    }

    function test_tradeInsertRejectsEmptyAndMismatchedBatches() public {
        bytes32[] memory none = new bytes32[](0);
        bytes[] memory noNotes = new bytes[](0);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.tradeInsert(none, noNotes);

        bytes32[] memory two = new bytes32[](2);
        two[0] = bytes32(uint256(1));
        two[1] = bytes32(uint256(2));
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.tradeInsert(two, new bytes[](1)); // fewer notes than leaves
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.tradeInsert(two, new bytes[](3)); // more notes than leaves
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.tradeInsert(none, new bytes[](1)); // no leaves, one note
    }

    function test_tradeInsertNoteSizeBoundary() public {
        bytes32[] memory one = new bytes32[](1);
        one[0] = bytes32(uint256(1));
        bytes[] memory notes = new bytes[](1);
        notes[0] = new bytes(pool.MAX_NOTE_BYTES());
        pool.tradeInsert(one, notes);
        notes[0] = new bytes(pool.MAX_NOTE_BYTES() + 1);
        vm.expectRevert(ShieldedPool.NoteTooLarge.selector);
        pool.tradeInsert(one, notes);
    }

    function test_tradeInsertPublishesTheNewRoot() public {
        uint256 rc = pool.rootCount();
        bytes32 before = pool.currentRoot();
        bytes32[] memory one = new bytes32[](1);
        one[0] = bytes32(uint256(123));
        pool.tradeInsert(one, new bytes[](1));
        assertEq(pool.nextLeaf(), 1);
        assertEq(pool.rootCount(), rc + 1);
        assertTrue(pool.currentRoot() != before);
        assertTrue(pool.isKnownRoot(pool.currentRoot()));
    }

    function test_tradeInsertSkipsZeroLeavesAndPublishesNothingForAllZero() public {
        uint256 rc = pool.rootCount();
        bytes32 before = pool.currentRoot();
        pool.tradeInsert(new bytes32[](2), new bytes[](2));
        assertEq(pool.nextLeaf(), 0);
        assertEq(pool.rootCount(), rc);
        assertEq(pool.currentRoot(), before);
        assertFalse(pool.isKnownRoot(bytes32(0)));
    }
}

contract ERC20Plain is ERC20 {
    constructor() ERC20("Plain", "PLN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
