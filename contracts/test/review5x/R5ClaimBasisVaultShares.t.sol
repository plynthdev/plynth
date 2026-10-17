// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {R3InsuranceCapNavTest} from "../review3/R3InsuranceCapNav.t.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";

/// review5 R5-TREAS-1 regression. `claimBasisNow()` used to take off only USDG and canonical Stock Token
/// withdrawals, so USDG moved into the allow-listed vault and withdrawn as shares stayed in the claim basis. It now
/// subtracts every decrease of the account's trusted holdings since the measurement, whatever form the value leaves
/// in. Real TreasuryFactory, PeriodClose clone, ExceptionInsurancePool, the fixture's allow-listed CashSleeve and vault.
contract R5ClaimBasisVaultSharesTest is R3InsuranceCapNavTest {
    function test_r5_usdgLeavingAsVaultSharesLowersTheClaimBasis() public {
        _setupFactoryTreasury(); // $1M USDG
        vm.prank(board);
        fAccount.registerDesk(CASH_DESK, cashKey, _one(address(cashSleeve))); // setup window: instant
        vm.prank(board);
        fAccount.registerDesk(EQUITY_DESK, eqKey, _one(address(eqSleeve)));
        // Inside the policy bands (cash 40-70%, equity 30-60%): $1M USDG + 2,500 AAPL ($500k) = $1.5M.
        aapl.mint(address(fAccount), 2_500e18);
        _honestClose();
        uint256 cap0 = ins.claimCapUsd(fAccount);
        assertApproxEqRel(cap0, 375_000e18, 1e15, "control: 25% of $1.5M");

        // After the measurement: the cash desk moves $50k (the fixture policy's board-approval threshold) into the
        // allow-listed vault, and the board withdraws the vault shares.
        _warp(block.timestamp + 1 hours);
        bytes memory data = _data(address(usdg), 50_000e6, 0, address(0), 50_000e6); // MockCashSleeve deposit (at the approval threshold)
        vm.prank(cashKey);
        fAccount.execute(CASH_DESK, address(cashSleeve), data, _allow(address(vault)), 0);
        uint256 shares = IERC20(address(vault)).balanceOf(address(fAccount));
        assertGt(shares, 0);
        vm.prank(board);
        fAccount.withdrawToBoard(address(vault), shares);
        vm.prank(board);
        IERC4626(address(vault)).redeem(shares, board, board);

        // The treasury now holds $1.45M, and the cap no longer counts the $50k that left.
        (uint256 nav,) = fAccount.navUsd();
        emit log_named_uint("treasury NAV now ($)", nav / 1e18);
        emit log_named_uint("claimBasisNow ($)", fClose.claimBasisNow() / 1e18);
        emit log_named_uint("claim cap ($)", ins.claimCapUsd(fAccount) / 1e18);
        assertApproxEqRel(nav, 1_450_000e18, 1e15);
        assertApproxEqRel(ins.claimCapUsd(fAccount), cap0 - 12_500e18, 1e15, "the $50k that left as vault shares is off");
        // and the same $50k withdrawn as USDG is taken off too
        vm.prank(board);
        fAccount.withdrawToBoard(address(usdg), 50_000e6);
        assertApproxEqRel(ins.claimCapUsd(fAccount), cap0 - 25_000e18, 1e15, "USDG withdrawals are subtracted");
        // value coming back never lifts the cap again before the next close (review6 R6-TREAS-1: low-water mark)
        usdg.mint(address(fAccount), 1_000_000e6);
        assertApproxEqRel(ins.claimCapUsd(fAccount), cap0 - 25_000e18, 1e15, "the low-water mark holds");
    }
}
