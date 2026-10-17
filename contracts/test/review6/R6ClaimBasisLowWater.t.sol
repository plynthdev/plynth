// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {R3InsuranceCapNavTest} from "../review3/R3InsuranceCapNav.t.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";

/// review6 R6-TREAS-1 regression (PoC: test/review6x/R6ClaimBasisRelend.t.sol on the review branch). `claimBasisNow()`
/// used to subtract only the CURRENT shortfall below the close's trusted holdings, so a loan lent in for the snapshot,
/// taken out, and lent in again in the `fileClaim` transaction restored the full inflated cap. It now subtracts the
/// low-water mark (`trustedLow`), lowered after every board withdrawal and desk operation. Real TreasuryFactory,
/// PeriodClose clone and ExceptionInsurancePool.
contract R6ClaimBasisLowWaterTest is R3InsuranceCapNavTest {
    function test_r6_relendAtFilingDoesNotRestoreTheCap() public {
        _setupFactoryTreasury(); // $1M USDG of the treasury's own

        uint256 loan = 9_000_000e6;
        usdg.mint(board, loan);
        vm.prank(board);
        usdg.transfer(address(fAccount), loan);
        _honestClose();
        assertGt(ins.claimCapUsd(fAccount), 2_400_000e18, "control: the cap right after the close counts the loan");

        vm.prank(board);
        fAccount.withdrawToBoard(address(usdg), loan);
        uint256 capOut = ins.claimCapUsd(fAccount);
        assertApproxEqRel(capOut, 250_000e18, 2e15, "the loan left: 25% of $1M");
        assertApproxEqRel(fClose.claimBasisLow(), 1_000_000e18, 2e15, "the withdrawal lowered the mark");

        _warp(block.timestamp + 3 days);
        vm.startPrank(board);
        usdg.transfer(address(fAccount), loan);
        uint256 capAtFiling = ins.claimCapUsd(fAccount);
        vm.expectRevert(); // above the cap
        ins.fileClaim(fAccount, 2_400_000e18, keccak256("evidence"));
        fAccount.withdrawToBoard(address(usdg), loan);
        vm.stopPrank();
        assertEq(capAtFiling, capOut, "lending the money back in does not lift the cap");
        assertLt(capAtFiling, 251_000e18);
    }

    /// The pinned-snapshot path: the loan leaves between snapshot and commit. The mark starts at the holdings at the
    /// commit, so lending back in later restores nothing.
    function test_r6_loanOutBetweenSnapshotAndCommitStaysOff() public {
        _setupFactoryTreasury();
        uint256 loan = 9_000_000e6;
        usdg.mint(board, loan);
        vm.prank(board);
        usdg.transfer(address(fAccount), loan);
        (bytes memory sig, bytes memory cdata) = _snapshotAndSign();
        vm.prank(board);
        fAccount.withdrawToBoard(address(usdg), loan); // close count 0: noteOutflow is a no-op
        _commitEncoded(cdata, sig);
        vm.prank(board);
        usdg.transfer(address(fAccount), loan);
        assertApproxEqRel(ins.claimCapUsd(fAccount), 250_000e18, 2e15, "the commit-time holdings bound the mark");
    }

    function test_r6_noteOutflowIsAccountOnly() public {
        _setupFactoryTreasury();
        _honestClose();
        vm.expectRevert(PeriodClose.NotAccount.selector);
        fClose.noteOutflow();
    }

    /// The insured loss itself still lowers the cap while the money is out (documented), and it stays lowered once
    /// any outflow has recorded it.
    function test_r6_unrecordedLossCountsLive() public {
        _setupFactoryTreasury();
        _honestClose();
        vm.prank(address(fAccount));
        usdg.transfer(makeAddr("exploiter"), 600_000e6);
        assertApproxEqRel(ins.claimCapUsd(fAccount), 100_000e18, 2e15);
    }
}
