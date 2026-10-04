// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {SavingsVault, ICanonicalRegistry} from "../../src/consumer/SavingsVault.sol";
import {ISignatureTransfer, IAllowanceTransfer} from "../../src/interfaces/IPermit2.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {SavingsVaultBase} from "./SavingsVaultBase.sol";

contract SavingsVaultTest is SavingsVaultBase {
    bytes32 internal constant TX1 = keccak256("tx1");
    bytes32 internal constant TX2 = keccak256("tx2");

    // ------------------------------------------------------------ deposits / withdraw

    function test_deposit_creditsAvailableAndEmits() public {
        usdg.mint(alice, 100 * U);
        vm.startPrank(alice);
        usdg.approve(address(vault), 100 * U);
        vm.expectEmit(address(vault));
        emit SavingsVault.Deposited(alice, 100 * U, false);
        vault.deposit(100 * U);
        vm.stopPrank();
        assertEq(_avail(alice), 100 * U);
        assertEq(usdg.balanceOf(address(vault)), 100 * U);
    }

    function test_deposit_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(SavingsVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_depositWithPermit2_realPermit2() public {
        usdg.mint(alice, 50 * U);
        vm.prank(alice);
        usdg.approve(permit2, type(uint256).max);
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) =
            _signPermit(alicePk, 50 * U, 7, block.timestamp + 1 hours);
        vm.expectEmit(address(vault));
        emit SavingsVault.Deposited(alice, 40 * U, true);
        vm.prank(alice);
        vault.depositWithPermit2(40 * U, p, sig);
        assertEq(_avail(alice), 40 * U);
        assertEq(usdg.balanceOf(alice), 10 * U);

        // nonce is spent inside Permit2
        vm.prank(alice);
        vm.expectRevert();
        vault.depositWithPermit2(10 * U, p, sig);
    }

    function test_depositWithPermit2_onlySignerCanSubmit() public {
        usdg.mint(alice, 50 * U);
        vm.prank(alice);
        usdg.approve(permit2, type(uint256).max);
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) =
            _signPermit(alicePk, 50 * U, 1, block.timestamp + 1 hours);
        vm.prank(bob); // bob cannot credit himself with alice's permit
        vm.expectRevert();
        vault.depositWithPermit2(50 * U, p, sig);
        assertEq(_avail(bob), 0);
        assertEq(usdg.balanceOf(alice), 50 * U);
    }

    function test_depositWithPermit2_wrongTokenReverts() public {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) =
            _signPermit(alicePk, 50 * U, 1, block.timestamp + 1 hours);
        p.permitted.token = tsla;
        vm.prank(alice);
        vm.expectRevert(SavingsVault.WrongPermitToken.selector);
        vault.depositWithPermit2(50 * U, p, sig);
    }

    function test_withdraw_takesAvailableFirstThenPending() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, 500 * U, 0);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U); // 9 USDG to pending
        assertEq(_pend(alice), 9 * U);

        vm.expectEmit(address(vault));
        emit SavingsVault.Withdrawn(alice, bob, 95 * U, 91 * U, 4 * U);
        vm.prank(alice);
        vault.withdraw(95 * U, bob);
        assertEq(_avail(alice), 0);
        assertEq(_pend(alice), 5 * U);
        assertEq(usdg.balanceOf(bob), 95 * U);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.InsufficientBalance.selector, 6 * U, 5 * U));
        vault.withdraw(6 * U, alice);
    }

    // ------------------------------------------------------------ settings / mix

    function test_setSettings_acceptsEverySiteOptionAndEmits() public {
        uint8[3] memory rounds = [uint8(1), 5, 10];
        uint64[4] memory tops = [uint64(0), uint64(25 * U), uint64(50 * U), uint64(100 * U)];
        for (uint256 i; i < 3; ++i) {
            for (uint8 m = 1; m <= 3; ++m) {
                for (uint256 t; t < 4; ++t) {
                    for (uint8 mode; mode <= 2; ++mode) {
                        vm.prank(alice);
                        vault.setSettings(SavingsVault.Settings(rounds[i], m, uint64(500 * U), tops[t], mode));
                    }
                }
            }
        }
        vm.expectEmit(address(vault));
        emit SavingsVault.SettingsSet(alice, 5, 2, uint64(100 * U), uint64(25 * U), 1);
        vm.prank(alice);
        vault.setSettings(SavingsVault.Settings(5, 2, uint64(100 * U), uint64(25 * U), 1));
        SavingsVault.Settings memory s = vault.settingsOf(alice);
        assertEq(s.roundTo, 5);
        assertEq(s.multiplier, 2);
        assertEq(s.weeklyCap, 100 * U);
        assertEq(s.fixedTopUp, 25 * U);
        assertEq(s.mode, 1);
        assertEq(vault.MAX_WEEKLY_CAP(), 500 * U);
    }

    function test_setSettings_rejectsOutsideTheSets() public {
        SavingsVault.Settings[8] memory bad = [
            SavingsVault.Settings(0, 1, uint64(U), 0, 0),
            SavingsVault.Settings(2, 1, uint64(U), 0, 0),
            SavingsVault.Settings(1, 0, uint64(U), 0, 0),
            SavingsVault.Settings(1, 4, uint64(U), 0, 0),
            SavingsVault.Settings(1, 1, uint64(500 * U + 1), 0, 0),
            SavingsVault.Settings(1, 1, uint64(U), uint64(30 * U), 0),
            SavingsVault.Settings(1, 1, uint64(U), uint64(25), 0), // whole-USDG 25, not base units
            SavingsVault.Settings(1, 1, uint64(U), 0, 3)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(SavingsVault.InvalidSettings.selector);
            vault.setSettings(bad[i]);
        }
    }

    function test_setMix_validStoresAndEmits() public {
        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](5);
        m[0] = SavingsVault.MixEntry(tsla, 4000);
        m[1] = SavingsVault.MixEntry(nvda, 3000);
        m[2] = SavingsVault.MixEntry(aapl, 1500);
        m[3] = SavingsVault.MixEntry(msft, 1000);
        m[4] = SavingsVault.MixEntry(meta, 500);
        vm.expectEmit(address(vault));
        emit SavingsVault.MixSet(alice, m);
        vm.prank(alice);
        vault.setMix(m);
        assertEq(vault.mixOf(alice).length, 5);

        _mix1(alice, nvda); // replaces, not appends
        SavingsVault.MixEntry[] memory got = vault.mixOf(alice);
        assertEq(got.length, 1);
        assertEq(got[0].stockToken, nvda);
        assertEq(got[0].weightBps, 10_000);
    }

    function test_setMix_rejectsBadMixes() public {
        SavingsVault.MixEntry[] memory empty = new SavingsVault.MixEntry[](0);
        _expectBadMix(empty);

        SavingsVault.MixEntry[] memory six = new SavingsVault.MixEntry[](6);
        address[6] memory toks = [tsla, nvda, aapl, msft, meta, mstr];
        for (uint256 i; i < 6; ++i) {
            six[i] = SavingsVault.MixEntry(toks[i], i == 0 ? 5000 : 1000);
        }
        _expectBadMix(six);

        SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](2);
        m[0] = SavingsVault.MixEntry(tsla, 5000);
        m[1] = SavingsVault.MixEntry(makeAddr("notListed"), 5000);
        _expectBadMix(m); // non-canonical

        m[1] = SavingsVault.MixEntry(tsla, 5000);
        _expectBadMix(m); // duplicate

        m[1] = SavingsVault.MixEntry(nvda, 4999);
        _expectBadMix(m); // sum != 10000

        m[0] = SavingsVault.MixEntry(tsla, 10_000);
        m[1] = SavingsVault.MixEntry(nvda, 0);
        _expectBadMix(m); // zero weight

        registry.delist(tsla);
        SavingsVault.MixEntry[] memory one = new SavingsVault.MixEntry[](1);
        one[0] = SavingsVault.MixEntry(tsla, 10_000);
        _expectBadMix(one); // delisted
    }

    function _expectBadMix(SavingsVault.MixEntry[] memory m) internal {
        vm.prank(alice);
        vm.expectRevert(SavingsVault.InvalidMix.selector);
        vault.setMix(m);
    }

    // ------------------------------------------------------------ R1 round-up

    function test_R1_roundUpExamples() public view {
        assertEq(vault.roundUp(3_400_000, 1, 1), 600_000); // 3.40 -> 4.00
        assertEq(vault.roundUp(3_400_000, 1, 2), 1_200_000);
        assertEq(vault.roundUp(12_300_000, 5, 1), 2_700_000); // 12.30 -> 15.00
        assertEq(vault.roundUp(12_300_000, 10, 3), 23_100_000); // 12.30 -> 20.00, x3
        assertEq(vault.roundUp(10 * U, 5, 3), 0); // exact multiple
        assertEq(vault.roundUp(0, 1, 1), 0);
        assertEq(vault.roundUp(1, 1, 1), U - 1);
        assertEq(vault.roundUp(7 * U, 0, 0), 0); // no settings
    }

    function _refRoundUp(uint256 spend, uint256 roundTo, uint256 mult) internal pure returns (uint256) {
        uint256 units = roundTo * 1e6;
        uint256 ceil = (spend + units - 1) / units; // ceil(spend / units)
        return (ceil * units - spend) * mult;
    }

    function testFuzz_R1_roundUpMatchesReference(uint256 spend, uint8 rIdx, uint8 mult) public view {
        spend = bound(spend, 0, 1e30);
        uint8 roundTo = [uint8(1), 5, 10][rIdx % 3];
        mult = uint8(bound(mult, 1, 3));
        assertEq(vault.roundUp(spend, roundTo, mult), _refRoundUp(spend, roundTo, mult));
    }

    function testFuzz_R1_accrueAddsReferenceRoundUp(uint256 spend, uint8 rIdx, uint8 mult) public {
        spend = bound(spend, 0, 1e30);
        uint8 roundTo = [uint8(1), 5, 10][rIdx % 3];
        mult = uint8(bound(mult, 1, 3));
        _fund(alice, 1000 * U);
        _settings(alice, roundTo, mult, uint64(500 * U), 0);
        vm.prank(keeper);
        uint256 added = vault.accrue(alice, TX1, 0, spend);
        assertEq(added, _refRoundUp(spend, roundTo, mult)); // max 29.999999 < cap and balance
        assertEq(_pend(alice), added);
        assertEq(_avail(alice), 1000 * U - added);
    }

    // ------------------------------------------------------------ R2 weekly cap

    function test_R2_weeklyCapClipsAndEmitsWeek() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 3, uint64(40 * U), 0);
        uint64 week = uint64(block.timestamp / 1 weeks);

        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 0, 1 * U), 27 * U); // 9 x3
        vm.expectEmit(address(vault));
        emit SavingsVault.Accrued(alice, TX1, 1, 1 * U, 13 * U, week);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 1, 1 * U), 13 * U); // clipped to 40
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 2, 1 * U), 0);
        assertEq(vault.accountOf(alice).accruedThisWeek, 40 * U);
        assertEq(_pend(alice), 40 * U);
    }

    function test_R2_newWeekResetsCounter() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(10 * U), 0);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 0, 1 * U), 9 * U);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 1, 1 * U), 1 * U);

        uint256 nextWeekStart = (block.timestamp / 1 weeks + 1) * 1 weeks;
        vm.warp(nextWeekStart - 1);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 2, 1 * U), 0); // still last week
        vm.warp(nextWeekStart);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 3, 1 * U), 9 * U);
        assertEq(vault.accountOf(alice).week, nextWeekStart / 1 weeks);
    }

    function test_R2_capLoweredBelowAccruedAddsZero() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(20 * U), 0);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U); // 9
        _settings(alice, 10, 1, uint64(5 * U), 0);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 1, 1 * U), 0);
    }

    function testFuzz_R2_accruedNeverExceedsCap(uint64 cap, uint256[8] memory spends, uint8[8] memory gaps) public {
        cap = uint64(bound(cap, 0, 500 * U));
        _fund(alice, 10_000 * U);
        _settings(alice, 10, 3, cap, 0);
        for (uint256 i; i < 8; ++i) {
            vm.warp(block.timestamp + uint256(gaps[i]) * 1 days);
            uint256 weekBefore = vault.accountOf(alice).week;
            uint256 accBefore = vault.accountOf(alice).accruedThisWeek;
            vm.prank(keeper);
            uint256 added = vault.accrue(alice, TX1, uint32(i), bound(spends[i], 0, 1e12));
            SavingsVault.Account memory a = vault.accountOf(alice);
            assertLe(a.accruedThisWeek, cap);
            assertEq(a.week, block.timestamp / 1 weeks);
            if (weekBefore == a.week) assertEq(a.accruedThisWeek, accBefore + added);
            else assertEq(a.accruedThisWeek, added);
        }
    }

    // ------------------------------------------------------------ R3 clip to available

    function test_R3_clippedToAvailableAndMovesAvailableToPending() public {
        _fund(alice, 2 * U);
        _settings(alice, 10, 1, uint64(500 * U), 0);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 0, 1 * U), 2 * U); // wanted 9
        assertEq(_avail(alice), 0);
        assertEq(_pend(alice), 2 * U);
        assertEq(vault.accountOf(alice).accruedThisWeek, 2 * U);
    }

    function test_R3_zeroIsNoopButMarksSourceUsed() public {
        _settings(alice, 10, 1, uint64(500 * U), 0); // no balance
        vm.expectEmit(address(vault));
        emit SavingsVault.Accrued(alice, TX1, 0, 1 * U, 0, uint64(block.timestamp / 1 weeks));
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 0, 1 * U), 0);
        assertTrue(vault.sourceUsed(keccak256(abi.encode(TX1, uint32(0)))));
        assertEq(vault.accountOf(alice).accruedThisWeek, 0);

        _fund(alice, 100 * U);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, TX1, uint32(0)));
        vault.accrue(alice, TX1, 0, 1 * U);
    }

    function test_R3_noSettingsAddsZero() public {
        _fund(alice, 100 * U);
        vm.prank(keeper);
        assertEq(vault.accrue(alice, TX1, 0, 1 * U), 0);
        assertEq(_avail(alice), 100 * U);
    }

    // ------------------------------------------------------------ R4 replay

    function test_R4_sourceUsableOnceEver() public {
        _fund(alice, 100 * U);
        _fund(bob, 100 * U);
        _settings(alice, 1, 1, uint64(500 * U), 0);
        _settings(bob, 1, 1, uint64(500 * U), 0);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 3, 1_500_000);

        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, TX1, uint32(3)));
        vault.accrue(alice, TX1, 3, 1_500_000);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, TX1, uint32(3)));
        vault.accrue(bob, TX1, 3, 1_500_000); // other user, same source
        vm.warp(block.timestamp + 52 weeks);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.AlreadyAccrued.selector, TX1, uint32(3)));
        vault.accrue(alice, TX1, 3, 1_500_000); // ever, not per week
        assertEq(vault.accrue(alice, TX1, 4, 1_500_000), 500_000); // other log index
        assertEq(vault.accrue(alice, TX2, 3, 1_500_000), 500_000); // other tx
        vm.stopPrank();
    }

    // ------------------------------------------------------------ R5 roles

    function test_R5_onlyKeeperAccruesAndPullsTopUp() public {
        _settings(alice, 1, 1, uint64(500 * U), uint64(25 * U));
        address[4] memory callers = [alice, owner, crowd, bob];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(SavingsVault.NotKeeper.selector);
            vault.accrue(alice, TX1, 0, 1);
            vm.expectRevert(SavingsVault.NotKeeper.selector);
            vault.pullFixedTopUp(alice);
            vm.stopPrank();
        }
    }

    function test_R5_onlyCrowdSweepsAndRefunds() public {
        address[4] memory callers = [alice, owner, keeper, bob];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(SavingsVault.NotCrowd.selector);
            vault.sweep(alice);
            vm.expectRevert(SavingsVault.NotCrowd.selector);
            vault.refundFromCrowd(alice, 1);
            vm.stopPrank();
        }
    }

    function test_R5_crowdIsSetOnceAndKeeperRotatesOnlyByOwner() public {
        vm.prank(owner);
        vm.expectRevert(SavingsVault.CrowdAlreadySet.selector);
        vault.setCrowd(bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setKeeper(alice);

        address k2 = makeAddr("keeper2");
        vm.expectEmit(address(vault));
        emit SavingsVault.KeeperSet(k2);
        vm.prank(owner);
        vault.setKeeper(k2);
        vm.prank(keeper);
        vm.expectRevert(SavingsVault.NotKeeper.selector);
        vault.accrue(alice, TX1, 0, 1);
        vm.prank(k2);
        vault.accrue(alice, TX1, 0, 1);
    }

    function test_R5_crowdUnsetMeansNobodySweeps() public {
        SavingsVault v2 =
            new SavingsVault(IERC20(address(usdg)), permit2, ICanonicalRegistry(address(registry)), owner, keeper);
        vm.prank(address(0));
        vm.expectRevert(SavingsVault.NotCrowd.selector);
        v2.sweep(alice);
        vm.prank(owner);
        vm.expectRevert(SavingsVault.ZeroAddress.selector);
        v2.setCrowd(address(0));
    }

    // ------------------------------------------------------------ R6 ungated exit

    function test_R6_withdrawNeedsNoKeeperOrOwner() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(500 * U), 0);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U);

        vm.startPrank(owner);
        vault.setKeeper(address(0));
        vault.renounceOwnership();
        vm.stopPrank();
        assertEq(vault.owner(), address(0));

        vm.prank(alice);
        vault.withdraw(100 * U, alice); // available and pending, both out
        assertEq(usdg.balanceOf(alice), 100 * U);
        (uint256 a, uint256 p) = vault.balancesOf(alice);
        assertEq(a + p, 0);
    }

    function test_R6_hostileKeeperCannotTakeFunds() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 3, uint64(500 * U), 0);
        address evil = makeAddr("evil");
        vm.prank(owner);
        vault.setKeeper(evil);
        vm.startPrank(evil);
        for (uint32 i; i < 20; ++i) {
            vault.accrue(alice, TX1, i, 1); // max round-ups
        }
        vm.expectRevert(SavingsVault.NoFixedTopUp.selector);
        vault.pullFixedTopUp(alice);
        vm.stopPrank();
        assertEq(usdg.balanceOf(evil), 0);
        assertEq(usdg.balanceOf(address(vault)), 100 * U);
        vm.prank(alice);
        vault.withdraw(100 * U, alice);
        assertEq(usdg.balanceOf(alice), 100 * U);
    }

    function test_R6_ownerSurfaceHasNoFundPath() public {
        // Every state-changing external function the owner can reach: setKeeper, setCrowd (once),
        // transferOwnership, acceptOwnership, renounceOwnership. None touches balances or tokens.
        _fund(alice, 100 * U);
        uint256 vaultBal = usdg.balanceOf(address(vault));
        vm.startPrank(owner);
        vault.setKeeper(owner);
        vault.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(bob);
        vault.acceptOwnership();
        vm.prank(bob);
        vault.renounceOwnership();
        assertEq(usdg.balanceOf(address(vault)), vaultBal);
        assertEq(_avail(alice), 100 * U);
    }

    // ------------------------------------------------------------ R7 wallet link

    function test_R7_linkWithWalletSignature() public {
        (address wallet, uint256 wpk) = makeAddrAndKey("card-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(wpk, alice, wallet, 0, deadline);
        vm.expectEmit(address(vault));
        emit SavingsVault.WalletLinked(alice, wallet, 0);
        vm.prank(alice);
        vault.linkSpendingWallet(wallet, deadline, sig);
        assertEq(vault.linkedUser(wallet), alice);
        assertEq(vault.linkNonce(wallet), 1);

        // replay of the same signature fails: nonce moved
        vm.prank(alice);
        vm.expectRevert(SavingsVault.BadSignature.selector);
        vault.linkSpendingWallet(wallet, deadline, sig);

        vm.prank(bob);
        vm.expectRevert(SavingsVault.NotLinked.selector);
        vault.unlinkSpendingWallet(wallet);
        vm.expectEmit(address(vault));
        emit SavingsVault.WalletUnlinked(alice, wallet);
        vm.prank(alice);
        vault.unlinkSpendingWallet(wallet);
        assertEq(vault.linkedUser(wallet), address(0));
    }

    function test_R7_signatureMustBeByWallet() public {
        (address wallet,) = makeAddrAndKey("card-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(alicePk, alice, wallet, 0, deadline); // alice signs, not the wallet
        vm.prank(alice);
        vm.expectRevert(SavingsVault.BadSignature.selector);
        vault.linkSpendingWallet(wallet, deadline, sig);
    }

    function test_R7_signatureBoundToUser() public {
        (address wallet, uint256 wpk) = makeAddrAndKey("card-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(wpk, alice, wallet, 0, deadline);
        vm.prank(bob); // bob front-runs with alice's signature
        vm.expectRevert(SavingsVault.BadSignature.selector);
        vault.linkSpendingWallet(wallet, deadline, sig);
    }

    function test_R7_signatureBoundToDeadline() public {
        (address wallet, uint256 wpk) = makeAddrAndKey("card-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(wpk, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(SavingsVault.BadSignature.selector);
        vault.linkSpendingWallet(wallet, deadline + 1, sig); // deadline altered
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(SavingsVault.SignatureExpired.selector);
        vault.linkSpendingWallet(wallet, deadline, sig);
    }

    function test_R7_signatureBoundToChainAndContract() public {
        (address wallet, uint256 wpk) = makeAddrAndKey("card-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(wpk, alice, wallet, 0, deadline);

        SavingsVault other =
            new SavingsVault(IERC20(address(usdg)), permit2, ICanonicalRegistry(address(registry)), owner, keeper);
        vm.prank(alice);
        vm.expectRevert(SavingsVault.BadSignature.selector);
        other.linkSpendingWallet(wallet, deadline, sig);

        uint256 chain = block.chainid;
        vm.chainId(4663);
        vm.prank(alice);
        vm.expectRevert(SavingsVault.BadSignature.selector);
        vault.linkSpendingWallet(wallet, deadline, sig);
        vm.chainId(chain);
        vm.prank(alice);
        vault.linkSpendingWallet(wallet, deadline, sig);
    }

    // ------------------------------------------------------------ fixed top-up

    function _grantAllowance(address user, uint160 amount, uint48 expiry) internal {
        usdg.mint(user, 1000 * U);
        vm.startPrank(user);
        usdg.approve(permit2, type(uint256).max);
        IAllowanceTransfer(permit2).approve(address(usdg), address(vault), amount, expiry);
        vm.stopPrank();
    }

    function test_pullFixedTopUp_amountFromSettingsEvery7Days() public {
        _settings(alice, 1, 1, uint64(500 * U), uint64(50 * U));
        _grantAllowance(alice, type(uint160).max, uint48(block.timestamp + 365 days));

        vm.expectEmit(address(vault));
        emit SavingsVault.TopUpPulled(alice, 50 * U);
        vm.prank(keeper);
        vault.pullFixedTopUp(alice);
        assertEq(_avail(alice), 50 * U);
        assertEq(usdg.balanceOf(alice), 950 * U);

        uint256 nextAt = block.timestamp + 7 days;
        vm.warp(nextAt - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SavingsVault.TopUpTooSoon.selector, nextAt));
        vault.pullFixedTopUp(alice);

        vm.warp(nextAt);
        vm.prank(keeper);
        vault.pullFixedTopUp(alice);
        assertEq(_avail(alice), 100 * U);
    }

    function test_pullFixedTopUp_respectsPermit2AllowanceAndExpiry() public {
        _settings(alice, 1, 1, uint64(500 * U), uint64(100 * U));
        _grantAllowance(alice, uint160(60 * U), uint48(block.timestamp + 1 days));
        vm.prank(keeper);
        vm.expectRevert(); // Permit2 InsufficientAllowance
        vault.pullFixedTopUp(alice);

        _settings(alice, 1, 1, uint64(500 * U), uint64(50 * U));
        vm.warp(block.timestamp + 2 days);
        vm.prank(keeper);
        vm.expectRevert(); // Permit2 AllowanceExpired
        vault.pullFixedTopUp(alice);
        assertEq(_avail(alice), 0);
        assertEq(vault.accountOf(alice).lastTopUpAt, 0);
    }

    function test_pullFixedTopUp_offWhenZero() public {
        _settings(alice, 1, 1, uint64(500 * U), 0);
        vm.prank(keeper);
        vm.expectRevert(SavingsVault.NoFixedTopUp.selector);
        vault.pullFixedTopUp(alice);
    }

    // ------------------------------------------------------------ sweep / refund

    function test_sweep_movesPendingToCrowdWithMix() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(500 * U), 0);
        _mix1(alice, tsla);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U);

        vm.expectEmit(address(vault));
        emit SavingsVault.Swept(alice, crowd, 9 * U);
        vm.prank(crowd);
        (SavingsVault.MixEntry[] memory mix, uint256 amount) = vault.sweep(alice);
        assertEq(amount, 9 * U);
        assertEq(mix.length, 1);
        assertEq(mix[0].stockToken, tsla);
        assertEq(usdg.balanceOf(crowd), 9 * U);
        assertEq(_pend(alice), 0);
        assertEq(_avail(alice), 91 * U);

        vm.prank(crowd);
        (, amount) = vault.sweep(alice); // nothing pending
        assertEq(amount, 0);
    }

    function test_sweep_withoutMixReverts() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(500 * U), 0);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U);
        vm.prank(crowd);
        vm.expectRevert(SavingsVault.NoMix.selector);
        vault.sweep(alice);
    }

    function test_refundFromCrowd_returnsToAvailable() public {
        _fund(alice, 100 * U);
        _settings(alice, 10, 1, uint64(500 * U), 0);
        _mix1(alice, tsla);
        vm.prank(keeper);
        vault.accrue(alice, TX1, 0, 1 * U);
        vm.startPrank(crowd);
        vault.sweep(alice);
        usdg.approve(address(vault), 9 * U);
        vm.expectEmit(address(vault));
        emit SavingsVault.Refunded(alice, 9 * U);
        vault.refundFromCrowd(alice, 9 * U);
        vm.stopPrank();
        assertEq(_avail(alice), 100 * U);
        assertEq(_pend(alice), 0);
        assertEq(usdg.balanceOf(address(vault)), 100 * U);
    }

    // ------------------------------------------------------------ R9 frozen user

    function test_R9_frozenUserRevertsAtTokenOthersUnaffected() public {
        _fund(alice, 100 * U);
        _fund(bob, 100 * U);
        usdg.freeze(alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountFrozen.selector, alice));
        vault.withdraw(10 * U, alice);
        assertEq(_avail(alice), 100 * U); // state rolled back

        vm.prank(bob);
        vault.withdraw(100 * U, bob);
        assertEq(usdg.balanceOf(bob), 100 * U);

        // Documented behaviour: the token checks from/to only, and here from = vault. A frozen holder can
        // still withdraw to another address; the vault does not enforce issuer freezes itself.
        vm.prank(alice);
        vault.withdraw(10 * U, makeAddr("alice-new"));
        assertEq(_avail(alice), 90 * U);
    }
}
