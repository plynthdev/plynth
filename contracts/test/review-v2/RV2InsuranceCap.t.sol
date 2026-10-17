// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ExceptionInsurancePoolTest} from "../token/ExceptionInsurancePool.t.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {MockPeriodClose} from "../mocks/TreasuryMocks.sol";

/// A sleeve the board registers itself: reports any value it likes.
contract InflatedSleeve {
    uint256 public v;

    constructor(uint256 v_) {
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

/// review-v2 V2-L11 regressions: the claim cap is read from the factory-made PeriodClose's period-start NAV
/// (not board-controlled live NAV or a swapped PeriodClose), and is a running per-treasury, per-period total.
contract RV2InsuranceCapTest is ExceptionInsurancePoolTest {
    function test_rv2_boardCannotInflateNavToLiftClaimCap() public {
        periodClose.close(1_000_000e18);
        assertEq(pool.claimCapUsd(account), 250_000e18, "honest cap: 25% of $1M");
        InflatedSleeve s = new InflatedSleeve(1e30);
        vm.prank(board);
        account.registerDesk("fake", board, _one(address(s)));
        assertEq(pool.claimCapUsd(account), 250_000e18, "a fake sleeve does not move the cap");
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, 250_000e18));
        pool.fileClaim(account, 5_000_000e18, EVIDENCE);
    }

    /// A PeriodClose the factory did not make for this treasury (swapped in through the timelock) is not trusted.
    function test_rv2_swappedPeriodCloseGivesNoCap() public {
        MockPeriodClose other = new MockPeriodClose();
        other.close(1e30);
        vm.prank(board);
        account.proposePeriodClose(address(other));
        vm.warp(block.timestamp + 30 days);
        account.applyPeriodClose();
        assertEq(account.periodClose(), address(other));
        assertEq(pool.claimCapUsd(account), 0);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, 0));
        pool.fileClaim(account, 1e18, EVIDENCE);
    }

    function test_rv2_oneLossCannotBeSplitIntoManyCappedClaims() public {
        periodClose.close(1_000_000e18);
        uint256 total;
        for (uint256 i; i < 8; ++i) {
            vm.prank(board);
            if (i == 0) {
                total += pool.claim(pool.fileClaim(account, 250_000e18, EVIDENCE)).amount;
            } else {
                vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, 0));
                pool.fileClaim(account, 250_000e18, EVIDENCE);
            }
        }
        assertEq(total, 250_000e6, "25% of NAV in total this period");
    }
}
