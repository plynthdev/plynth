// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {R3InsuranceCapNavTest, BoardSleeve} from "../review3/R3InsuranceCapNav.t.sol";
import {ExceptionInsurancePool} from "../../src/token/ExceptionInsurancePool.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// A sleeve the board writes that declares a token it mints as "cash" (AssetValuation KIND_CASH = $1 a token).
contract JunkCashSleeve {
    address public junk;

    constructor(address junk_) {
        junk = junk_;
    }

    function band() external pure returns (uint8) {
        return 0;
    }

    function assets() external view returns (address[] memory a, uint8[] memory k) {
        a = new address[](1);
        k = new uint8[](1);
        a[0] = junk;
    }

    function valueOf(address account) external view returns (uint256, bool) {
        return (MockUSDG(junk).balanceOf(account) * 1e12, false);
    }

    function run(bytes calldata) external pure returns (bytes memory) {
        return "";
    }
}

/// review4 R4-TREAS-2 regression. A board sleeve registered one period early counted in full in `claimBasisNav`
/// (cap ~$250B). The claim basis is now only USDG (1:1), canonical Stock Tokens (Valuer) and the proven private part
/// held at the measurement, less what was withdrawn to the board since. Real factory, PeriodClose clone, pool.
contract R4ClaimBasisOnePeriodLaterTest is R3InsuranceCapNavTest {
    function test_r4_sleeveRegisteredOnePeriodEarlyDoesNotLiftClaimCap() public {
        _setupFactoryTreasury();
        BoardSleeve fake = new BoardSleeve(0);
        _allowListed(address(fake));
        vm.prank(board);
        fAccount.registerDesk("fake", board, _one(address(fake)));
        _honestClose();
        assertApproxEqRel(ins.claimCapUsd(fAccount), 250_000e18, 1e15, "control: cap from the honest $1M");

        fake.set(1e12 * 1e18);
        _honestClose();
        assertGt(fClose.periodStartNav(), 1e11 * 1e18, "the drawdown base counts it (stricter for the board)");
        // the claim basis does not (the fee on the inflated statement even drains the real cash: the board pays)
        assertLe(ins.claimCapUsd(fAccount), 250_000e18, "the claim basis does not");
        fake.set(0);
        uint256 cap = ins.claimCapUsd(fAccount);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(ExceptionInsurancePool.ClaimTooLarge.selector, cap));
        ins.fileClaim(fAccount, 50_000_000e18, keccak256("evidence"));
    }

    /// A token the board mints, declared as "cash" by a sleeve of its own, is worth 0 in the claim basis.
    function test_r4_boardDeclaredJunkCashDoesNotLiftClaimCap() public {
        _setupFactoryTreasury();
        MockUSDG junk = new MockUSDG();
        JunkCashSleeve s = new JunkCashSleeve(address(junk));
        _allowListed(address(s));
        vm.prank(board);
        fAccount.registerDesk("junk", board, _one(address(s)));
        junk.mint(address(fAccount), 1e12 * 1e6);
        _honestClose();
        assertApproxEqRel(ins.claimCapUsd(fAccount), 250_000e18, 1e15);
    }

    /// Value lent in for the snapshot block and withdrawn right after (a flash loan through the board) never lifts
    /// the cap: `claimBasisNow` takes off everything withdrawn to the board since the measurement.
    function test_r4_valueInForTheSnapshotAndOutAgainDoesNotLiftClaimCap() public {
        _setupFactoryTreasury();
        usdg.mint(address(fAccount), 1e12 * 1e6); // "borrowed"
        (bytes memory sig, bytes memory cdata) = _snapshotAndSign();
        vm.prank(board);
        fAccount.withdrawToBoard(address(usdg), 1e12 * 1e6); // repaid
        _commitEncoded(cdata, sig);
        assertGt(fClose.claimBasisNav(), 1e11 * 1e18, "measured at the snapshot");
        assertLe(ins.claimCapUsd(fAccount), 250_000e18 + 1e18, "but the withdrawal since is taken off");
    }
}
