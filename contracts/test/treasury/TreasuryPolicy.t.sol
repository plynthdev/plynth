// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";

contract TreasuryPolicyTest is Test {
    TreasuryPolicy tp;
    address board = makeAddr("board");
    address controller = makeAddr("controller");
    address anyone = makeAddr("anyone");
    uint64 constant T0 = 1_800_000_000;

    event PolicyProposed(bytes32 indexed hash, uint64 eta);
    event PolicyCancelled(bytes32 indexed hash);
    event PolicyActivated(bytes32 indexed hash, uint32 indexed version);

    function _good() internal view returns (TreasuryPolicy.Policy memory p) {
        p.cash = TreasuryPolicy.Band(7000, 9000);
        p.equity = TreasuryPolicy.Band(1000, 3000);
        p.perOrderCapUsd = 50_000;
        p.perDayCapUsd = 250_000;
        p.perNameFloatCapBps = 50;
        p.noNewRiskOffHours = true;
        p.pauseNewRiskAtDrawdownBps = -300;
        p.deriskAtDrawdownBps = -600;
        p.approvalAboveUsd = 25_000;
        p.periodSeconds = 30 days;
        p.instrumentAllowRoot = keccak256("root");
        p.controller = controller;
    }

    function setUp() public {
        vm.warp(T0);
        tp = new TreasuryPolicy(board, _good());
    }

    function _propose(TreasuryPolicy.Policy memory p) internal {
        vm.prank(board);
        tp.propose(p);
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_activatesFirstPolicyImmediately() public view {
        (TreasuryPolicy.Policy memory p, bytes32 h, uint32 v) = tp.current();
        assertEq(v, 1);
        assertEq(h, keccak256(abi.encode(_good())));
        assertEq(p.controller, controller);
        (,, uint64 at) = tp.policyAt(1);
        assertEq(at, T0);
        assertEq(tp.board(), board);
        assertEq(tp.TIMELOCK(), 48 hours);
    }

    function test_constructor_validates() public {
        TreasuryPolicy.Policy memory p = _good();
        p.controller = address(0);
        vm.expectRevert(TreasuryPolicy.ZeroAddress.selector);
        new TreasuryPolicy(board, p);
    }

    function test_constructor_rejectsZeroBoard() public {
        vm.expectRevert(TreasuryPolicy.ZeroAddress.selector);
        new TreasuryPolicy(address(0), _good());
    }

    // ------------------------------------------------------------ timelock

    function test_propose_onlyBoard() public {
        vm.prank(anyone);
        vm.expectRevert(TreasuryPolicy.NotBoard.selector);
        tp.propose(_good());
    }

    function test_cancel_onlyBoard() public {
        _propose(_good());
        vm.prank(anyone);
        vm.expectRevert(TreasuryPolicy.NotBoard.selector);
        tp.cancel();
    }

    function test_propose_emitsAndStoresPending() public {
        TreasuryPolicy.Policy memory p = _good();
        p.perOrderCapUsd = 1;
        bytes32 h = keccak256(abi.encode(p));
        vm.expectEmit(true, false, false, true);
        emit PolicyProposed(h, T0 + 48 hours);
        _propose(p);
        (TreasuryPolicy.Policy memory q, bytes32 ph, uint64 eta) = tp.pending();
        assertEq(ph, h);
        assertEq(eta, T0 + 48 hours);
        assertEq(q.perOrderCapUsd, 1);
    }

    function test_timelock_cannotBeBypassed() public {
        _propose(_good());
        vm.warp(T0 + 48 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.TimelockActive.selector, T0 + 48 hours));
        tp.activate();
        vm.warp(T0 + 48 hours);
        vm.prank(anyone); // anyone can activate
        tp.activate();
        (,, uint32 v) = tp.current();
        assertEq(v, 2);
    }

    function test_activate_emitsHashAndVersion() public {
        TreasuryPolicy.Policy memory p = _good();
        p.perDayCapUsd = 999_999;
        _propose(p);
        vm.warp(T0 + 48 hours);
        vm.expectEmit(true, true, false, false);
        emit PolicyActivated(keccak256(abi.encode(p)), 2);
        tp.activate();
        (TreasuryPolicy.Policy memory c, bytes32 h,) = tp.current();
        assertEq(c.perDayCapUsd, 999_999);
        assertEq(h, tp.hashPolicy(p));
        (,, uint64 eta) = tp.pending();
        assertEq(eta, 0);
    }

    function test_activate_nothingPending() public {
        vm.expectRevert(TreasuryPolicy.NothingPending.selector);
        tp.activate();
    }

    function test_activate_twiceReverts() public {
        _propose(_good());
        vm.warp(T0 + 48 hours);
        tp.activate();
        vm.expectRevert(TreasuryPolicy.NothingPending.selector);
        tp.activate();
    }

    function test_newProposalReplacesAndRestartsClock() public {
        TreasuryPolicy.Policy memory a = _good();
        a.perOrderCapUsd = 1;
        _propose(a);
        vm.warp(T0 + 47 hours);
        TreasuryPolicy.Policy memory b = _good();
        b.perOrderCapUsd = 2;
        _propose(b);
        vm.warp(T0 + 48 hours); // a's eta, not b's
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.TimelockActive.selector, T0 + 95 hours));
        tp.activate();
        vm.warp(T0 + 95 hours);
        tp.activate();
        (TreasuryPolicy.Policy memory c,,) = tp.current();
        assertEq(c.perOrderCapUsd, 2);
    }

    function test_cancel_clearsPending() public {
        _propose(_good());
        bytes32 h = tp.pendingHash();
        vm.expectEmit(true, false, false, false);
        emit PolicyCancelled(h);
        vm.prank(board);
        tp.cancel();
        vm.warp(T0 + 48 hours);
        vm.expectRevert(TreasuryPolicy.NothingPending.selector);
        tp.activate();
    }

    function test_cancel_nothingPending() public {
        vm.prank(board);
        vm.expectRevert(TreasuryPolicy.NothingPending.selector);
        tp.cancel();
    }

    // ------------------------------------------------------------ history

    function test_versionAt_acrossThreeVersions() public {
        TreasuryPolicy.Policy memory p = _good();
        p.perOrderCapUsd = 2;
        _propose(p);
        vm.warp(T0 + 3 days);
        tp.activate(); // v2 at T0+3d
        p.perOrderCapUsd = 3;
        _propose(p);
        vm.warp(T0 + 10 days);
        tp.activate(); // v3 at T0+10d

        assertEq(tp.versionAt(T0 - 1), 0);
        assertEq(tp.versionAt(T0), 1);
        assertEq(tp.versionAt(T0 + 3 days - 1), 1);
        assertEq(tp.versionAt(T0 + 3 days), 2);
        assertEq(tp.versionAt(T0 + 10 days - 1), 2);
        assertEq(tp.versionAt(T0 + 10 days), 3);
        assertEq(tp.versionAt(type(uint64).max), 3);

        (TreasuryPolicy.Policy memory p2,, uint64 at2) = tp.policyAt(2);
        assertEq(p2.perOrderCapUsd, 2);
        assertEq(at2, T0 + 3 days);
        (TreasuryPolicy.Policy memory p3, bytes32 h3, uint64 at3) = tp.policyAt(3);
        assertEq(p3.perOrderCapUsd, 3);
        assertEq(h3, keccak256(abi.encode(p)));
        assertEq(at3, T0 + 10 days);
        (TreasuryPolicy.Policy memory p1,,) = tp.policyAt(1);
        assertEq(p1.perOrderCapUsd, 50_000);
    }

    function test_policyAt_unknownVersion() public {
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.UnknownVersion.selector, uint32(0)));
        tp.policyAt(0);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.UnknownVersion.selector, uint32(2)));
        tp.policyAt(2);
    }

    /// Fuzz: versionAt matches a linear scan for many versions at random gaps.
    function testFuzz_versionAt_matchesLinearScan(uint8 n, uint64 seed, uint64 probe) public {
        n = uint8(bound(n, 1, 12));
        uint64[] memory at = new uint64[](n + 1);
        at[0] = T0;
        for (uint256 i = 1; i <= n; i++) {
            _propose(_good());
            uint64 gap = 48 hours + uint64(uint256(keccak256(abi.encode(seed, i))) % 30 days);
            vm.warp(block.timestamp + gap);
            tp.activate();
            at[i] = uint64(block.timestamp);
        }
        probe = uint64(bound(probe, T0 - 1 days, at[n] + 1 days));
        uint32 expected = 0;
        for (uint256 i = 0; i <= n; i++) {
            if (at[i] <= probe) expected = uint32(i + 1);
        }
        assertEq(tp.versionAt(probe), expected);
    }

    // ------------------------------------------------------------ validation

    function _expectInvalid(TreasuryPolicy.Policy memory p, bytes4 sel) internal {
        vm.expectRevert(sel);
        tp.validate(p);
        vm.prank(board);
        vm.expectRevert(sel);
        tp.propose(p);
    }

    function test_validate_goodPolicyPasses() public view {
        tp.validate(_good());
    }

    function test_validate_bandMinAboveMax() public {
        TreasuryPolicy.Policy memory p = _good();
        p.equity = TreasuryPolicy.Band(3001, 3000);
        _expectInvalid(p, TreasuryPolicy.BadBand.selector);
    }

    function test_validate_bandMaxAbove10000() public {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(7000, 10_001);
        _expectInvalid(p, TreasuryPolicy.BadBand.selector);
    }

    function test_validate_sumOfMinsAbove10000() public {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(8000, 9000);
        p.equity = TreasuryPolicy.Band(2001, 3000);
        _expectInvalid(p, TreasuryPolicy.BadBandSums.selector);
    }

    function test_validate_sumOfMaxesBelow10000() public {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(7000, 7000);
        p.equity = TreasuryPolicy.Band(1000, 2999);
        _expectInvalid(p, TreasuryPolicy.BadBandSums.selector);
    }

    function test_validate_sumsExactlyAtBoundsPass() public view {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(7000, 7000);
        p.equity = TreasuryPolicy.Band(3000, 3000);
        tp.validate(p);
    }

    function test_validate_t1BasisMustBeZero() public {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(6000, 9000);
        p.basis = TreasuryPolicy.Band(0, 1000);
        _expectInvalid(p, TreasuryPolicy.T1Basis.selector);
    }

    function test_validate_t1NetDeltaMustBeZero() public {
        TreasuryPolicy.Policy memory p = _good();
        p.netDeltaMinBps = -100;
        _expectInvalid(p, TreasuryPolicy.T1NetDelta.selector);
        p.netDeltaMinBps = 0;
        p.netDeltaMaxBps = 100;
        _expectInvalid(p, TreasuryPolicy.T1NetDelta.selector);
    }

    function test_validate_t1NoLeverage() public {
        TreasuryPolicy.Policy memory p = _good();
        p.maxLeverageX10 = 10;
        _expectInvalid(p, TreasuryPolicy.T1Leverage.selector);
    }

    function test_validate_t1NoVenues() public {
        TreasuryPolicy.Policy memory p = _good();
        p.perVenueCapBps = 1;
        _expectInvalid(p, TreasuryPolicy.T1Venue.selector);
        p.perVenueCapBps = 0;
        p.venueAllowRoot = bytes32(uint256(1));
        _expectInvalid(p, TreasuryPolicy.T1Venue.selector);
    }

    function test_validate_floatCapAtMost200() public {
        TreasuryPolicy.Policy memory p = _good();
        p.perNameFloatCapBps = 200;
        tp.validate(p);
        p.perNameFloatCapBps = 201;
        _expectInvalid(p, TreasuryPolicy.FloatCapTooHigh.selector);
    }

    function test_validate_drawdown() public {
        TreasuryPolicy.Policy memory p = _good();
        p.deriskAtDrawdownBps = -300; // equal to pause
        _expectInvalid(p, TreasuryPolicy.BadDrawdown.selector);
        p.deriskAtDrawdownBps = -200; // above pause
        _expectInvalid(p, TreasuryPolicy.BadDrawdown.selector);
        p.pauseNewRiskAtDrawdownBps = 1; // positive pause
        p.deriskAtDrawdownBps = -600;
        _expectInvalid(p, TreasuryPolicy.BadDrawdown.selector);
        p.pauseNewRiskAtDrawdownBps = 0; // pause == 0 is allowed
        tp.validate(p);
    }

    function test_validate_periodAtLeastOneDay() public {
        TreasuryPolicy.Policy memory p = _good();
        p.periodSeconds = 1 days;
        tp.validate(p);
        p.periodSeconds = 1 days - 1;
        _expectInvalid(p, TreasuryPolicy.BadPeriod.selector);
    }

    function test_validate_controllerNonZero() public {
        TreasuryPolicy.Policy memory p = _good();
        p.controller = address(0);
        _expectInvalid(p, TreasuryPolicy.ZeroAddress.selector);
    }

    /// Fuzz the band rules against a reference model; the T1 basis band stays {0,0}.
    function testFuzz_validate_bands(uint16 cMin, uint16 cMax, uint16 eMin, uint16 eMax) public {
        TreasuryPolicy.Policy memory p = _good();
        p.cash = TreasuryPolicy.Band(cMin, cMax);
        p.equity = TreasuryPolicy.Band(eMin, eMax);
        bool bandsOk = cMin <= cMax && cMax <= 10_000 && eMin <= eMax && eMax <= 10_000;
        bool sumsOk = uint256(cMin) + eMin <= 10_000 && uint256(cMax) + eMax >= 10_000;
        if (!bandsOk) {
            vm.expectRevert(TreasuryPolicy.BadBand.selector);
        } else if (!sumsOk) {
            vm.expectRevert(TreasuryPolicy.BadBandSums.selector);
        }
        tp.validate(p);
    }

    /// Fuzz bands drawn inside the valid region: always accepted.
    function testFuzz_validate_validBandsAccepted(uint16 cMin, uint16 width) public view {
        cMin = uint16(bound(cMin, 0, 10_000));
        TreasuryPolicy.Policy memory p = _good();
        uint16 eMin = 0;
        uint16 eMax = uint16(10_000 - cMin);
        uint16 cMax = uint16(bound(width, cMin, 10_000));
        p.cash = TreasuryPolicy.Band(cMin, cMax);
        p.equity = TreasuryPolicy.Band(eMin, eMax);
        tp.validate(p);
    }

    /// Fuzz the drawdown and period rules against a reference model.
    function testFuzz_validate_drawdownAndPeriod(int16 pause, int16 derisk, uint32 period) public {
        TreasuryPolicy.Policy memory p = _good();
        p.pauseNewRiskAtDrawdownBps = pause;
        p.deriskAtDrawdownBps = derisk;
        p.periodSeconds = period;
        if (!(derisk < pause && pause <= 0)) vm.expectRevert(TreasuryPolicy.BadDrawdown.selector);
        else if (period < 1 days) vm.expectRevert(TreasuryPolicy.BadPeriod.selector);
        tp.validate(p);
    }

    /// Fuzz the T1 zero-field rules: any nonzero value is rejected.
    function testFuzz_validate_t1Fields(int16 dMin, int16 dMax, uint16 lev, uint16 venueCap, bytes32 venueRoot)
        public
    {
        TreasuryPolicy.Policy memory p = _good();
        p.netDeltaMinBps = dMin;
        p.netDeltaMaxBps = dMax;
        p.maxLeverageX10 = lev;
        p.perVenueCapBps = venueCap;
        p.venueAllowRoot = venueRoot;
        if (dMin != 0 || dMax != 0) vm.expectRevert(TreasuryPolicy.T1NetDelta.selector);
        else if (lev != 0) vm.expectRevert(TreasuryPolicy.T1Leverage.selector);
        else if (venueCap != 0 || venueRoot != bytes32(0)) vm.expectRevert(TreasuryPolicy.T1Venue.selector);
        tp.validate(p);
    }

    // ------------------------------------------------------------ instruments

    function test_isInstrumentAllowed_twoLeafTree() public {
        address usdg = makeAddr("usdg");
        address tsla = makeAddr("tsla");
        bytes32 a = tp.instrumentLeaf(usdg, 0);
        bytes32 b = tp.instrumentLeaf(tsla, 2);
        assertEq(a, keccak256(abi.encode(usdg, uint8(0))));
        bytes32 root = a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
        TreasuryPolicy.Policy memory p = _good();
        p.instrumentAllowRoot = root;
        TreasuryPolicy t = new TreasuryPolicy(board, p);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;
        assertTrue(t.isInstrumentAllowed(usdg, 0, proof));
        assertFalse(t.isInstrumentAllowed(usdg, 2, proof)); // wrong kind
        proof[0] = a;
        assertTrue(t.isInstrumentAllowed(tsla, 2, proof));
        assertFalse(t.isInstrumentAllowed(anyone, 2, proof));
    }
}
