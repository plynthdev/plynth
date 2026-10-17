// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryFactoryTest} from "../treasury/TreasuryFactory.t.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";

/// A sleeve the board registers itself (instant `registerDesk`): reports whatever value it likes.
contract BoardSleeve {
    uint256 public v;

    constructor(uint256 v_) {
        v = v_;
    }

    function set(uint256 v_) external {
        v = v_;
    }

    function band() external pure returns (uint8) {
        return 0;
    }

    function assets() external pure returns (address[] memory a, uint8[] memory k) {
        return (a, k);
    }

    function valueOf(address) external view returns (uint256, bool) {
        return (v, false);
    }

    function run(bytes calldata) external pure returns (bytes memory) {
        return "";
    }
}

/// review3 R3-TREAS-2 regression, and the V2-L11 proving tests redone on real contracts (real TreasuryFactory, real
/// PeriodClose clone, real ExceptionInsurancePool; no MockPeriodClose). The old `_commitPublic` stored the LIVE NAV
/// after checking the snapshot, so a sleeve the board registered between snapshot and commit (reporting $1e12) lifted
/// the per-period claim cap to ~$250B. The start NAV is now the checked statement, and the claim basis leaves out
/// sleeves registered during the period being closed.
contract R3InsuranceCapNavTest is TreasuryFactoryTest {
    address committee = makeAddr("committee");
    ExceptionInsurancePool ins;

    /// The factory allow-list (review5) now refuses a board-written adapter. To keep testing the claim basis as a
    /// second line of defence, these tests put the fake on the list as if it had passed review and misreports.
    function _allowListed(address a) internal returns (address) {
        factory.setAdapterAllowed(a.codehash, true);
        return a;
    }

    function _setupFactoryTreasury() internal {
        _deploy(board);
        usdg.mint(address(fAccount), 1_000_000e6); // $1M loose cash
        ins = new ExceptionInsurancePool(IERC20Metadata(address(usdg)), committee, 14 days);
        ins.bindTreasuryFactory(address(factory));
    }

    function _signedSnapshotClose() internal returns (PeriodClose.Close memory c, bytes memory sig) {
        _toNextPeriodEnd();
        vm.prank(controller);
        (bytes32 posHash, uint256 nav, uint16 cashBps, uint16 eqBps) = fClose.snapshot();
        (, bytes32 h, uint32 v) = fPolicy.current();
        c = PeriodClose.Close(uint64(block.timestamp), nav, cashBps, eqBps, posHash, keccak256("bundle"), h, v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(controllerKey, fClose.digest(c));
        sig = abi.encodePacked(r, s, vv);
    }

    function _toNextPeriodEnd() internal {
        uint64 next = fClose.nextPeriodEnd();
        _warp(block.timestamp < next ? next + 1 : block.timestamp + 1);
    }

    function _snapshotAndSign() internal returns (bytes memory sig, bytes memory cdata) {
        PeriodClose.Close memory c;
        (c, sig) = _signedSnapshotClose();
        cdata = abi.encode(c);
    }

    function _commitEncoded(bytes memory cdata, bytes memory sig) internal {
        fClose.commitSnapshot(abi.decode(cdata, (PeriodClose.Close)), sig);
    }

    function _honestClose() internal {
        (PeriodClose.Close memory c, bytes memory sig) = _signedSnapshotClose();
        fClose.commitSnapshot(c, sig);
    }

    function test_r3_control_honestCloseCapIs25PctOfNav() public {
        _setupFactoryTreasury();
        _honestClose();
        assertEq(fClose.claimBasisNav(), fClose.periodStartNav(), "no new sleeve: basis = start");
        assertApproxEqRel(ins.claimCapUsd(fAccount), 250_000e18, 1e15);
    }

    function test_r3_boardSleeveBetweenSnapshotAndCommitDoesNotLiftClaimCap() public {
        _setupFactoryTreasury();
        (PeriodClose.Close memory c, bytes memory sig) = _signedSnapshotClose();
        assertEq(c.navUsd, 1_000_000e18, "controller signed the honest $1M book");

        BoardSleeve fake = new BoardSleeve(1e12 * 1e18);
        _allowListed(address(fake));
        vm.prank(board);
        fAccount.registerDesk("fake", board, _one(address(fake)));

        fClose.commitSnapshot(c, sig);
        assertLe(fClose.periodStartNav(), 1_000_000e18, "start NAV is the checked statement, not the live book");
        assertApproxEqRel(ins.claimCapUsd(fAccount), 250_000e18, 1e15, "cap from the honest $1M");

        fake.set(0);
        uint256 cap = ins.claimCapUsd(fAccount);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, cap));
        ins.fileClaim(fAccount, 50_000_000e18, keccak256("evidence"));
    }

    /// The board registers the fake sleeve BEFORE the controller's snapshot: the statement (and the drawdown base)
    /// includes it, but a sleeve registered during the period counts in the claim basis only from the next one.
    function test_r3_boardSleeveBeforeSnapshotCountsOnlyFromNextPeriod() public {
        _setupFactoryTreasury();
        BoardSleeve fake = new BoardSleeve(1e12 * 1e18);
        _allowListed(address(fake));
        vm.prank(board);
        fAccount.registerDesk("fake", board, _one(address(fake)));
        _honestClose();
        assertGt(fClose.periodStartNav(), 1e11 * 1e18, "the statement counted it (self-harm for the drawdown rule)");
        assertLe(ins.claimCapUsd(fAccount), 250_000e18, "the claim basis did not");
        vm.prank(board);
        vm.expectRevert();
        ins.fileClaim(fAccount, 50_000_000e18, keccak256("evidence"));
    }

    /// V2-L11 on real contracts: one loss cannot be split into 8 claims of 25%; the next real close reopens the cap.
    function test_r3_runningCapPerRealPeriod() public {
        _setupFactoryTreasury();
        _honestClose();
        uint256 cap = ins.claimCapUsd(fAccount);
        vm.prank(board);
        ins.fileClaim(fAccount, cap, keccak256("evidence"));
        for (uint256 i; i < 7; ++i) {
            vm.prank(board);
            vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, 0));
            ins.fileClaim(fAccount, cap, keccak256("evidence"));
        }
        _honestClose(); // the next period
        assertGt(ins.claimCapUsd(fAccount), 0, "a new period, a new cap");
    }

    /// The live `commit` path does the same, and (review4 R4-TREAS-2) a board sleeve's own value never counts in the
    /// claim basis, however long it has been registered; it still counts in the drawdown base (stricter).
    function test_r3_liveCommitBoardSleeveNeverCountsInClaimBasis() public {
        _setupFactoryTreasury();
        BoardSleeve extra = new BoardSleeve(500_000e18);
        _allowListed(address(extra));
        vm.prank(board);
        fAccount.registerDesk("extra", board, _one(address(extra)));
        _toNextPeriodEnd();
        (bytes32 posHash,,,) = _peek();
        (uint256 nav,) = fAccount.navUsd();
        PeriodClose.Close memory c = _liveClose(posHash, nav);
        (uint8 vv, bytes32 r, bytes32 s_) = vm.sign(controllerKey, fClose.digest(c));
        fClose.commit(c, abi.encodePacked(r, s_, vv));
        assertEq(fClose.claimBasisNav(), fClose.periodStartNav() - 500_000e18, "board sleeve: left out");
        _honestClose();
        assertEq(fClose.claimBasisNav(), fClose.periodStartNav() - 500_000e18, "a period later: still left out");
    }

    function _peek() internal returns (bytes32 posHash, uint256 nav, uint16 cashBps, uint16 eqBps) {
        uint256 id = vm.snapshotState();
        vm.prank(controller);
        (posHash, nav, cashBps, eqBps) = fClose.snapshot();
        vm.revertToState(id);
    }

    function _liveClose(bytes32 posHash, uint256 nav) internal returns (PeriodClose.Close memory c) {
        (,, uint16 cashBps, uint16 eqBps) = _peek();
        (, bytes32 h, uint32 v) = fPolicy.current();
        c = PeriodClose.Close(uint64(block.timestamp), nav, cashBps, eqBps, posHash, keccak256("bundle"), h, v);
    }
}
