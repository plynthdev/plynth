// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TreasuryFixture} from "./TreasuryFixture.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {ITierSource} from "../../src/interfaces/ITierSource.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract PeriodCloseTest is TreasuryFixture {
    PeriodClose pc;
    address feeTo = makeAddr("feeTo");
    uint256 controllerKey = uint256(keccak256(abi.encodePacked("controller"))); // test-key (forge makeAddr)
    uint256 constant PERIOD = 30 days;

    function _wireMockPeriodClose() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        assertEq(vm.addr(controllerKey), controller);
        pc = new PeriodClose(account, IERC20Metadata(address(usdg)), feeTo, ITierSource(address(0)));
        vm.prank(board);
        account.setPeriodClose(address(pc));
    }

    // ------------------------------------------------------------ helpers

    function _build(uint64 periodEnd) internal view returns (PeriodClose.Close memory c) {
        (, bytes32 posHash, uint256 nav, uint16 cBps, uint16 eBps,) = pc.preview();
        (, bytes32 h, uint32 v) = policy.current();
        c = PeriodClose.Close(periodEnd, nav, cBps, eBps, posHash, keccak256("bundle"), h, v);
    }

    function _sign(PeriodClose.Close memory c, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pc.digest(c));
        return abi.encodePacked(r, s, v);
    }

    function _commit(PeriodClose.Close memory c) internal {
        pc.commit(c, _sign(c, controllerKey));
    }

    function _closeAfter(uint256 dt) internal returns (PeriodClose.Close memory c) {
        _warp(block.timestamp + dt);
        c = _build(uint64(block.timestamp));
        _commit(c);
    }

    // ------------------------------------------------------------ happy path

    function test_commitHappyPath() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        assertEq(c.navUsd, 1_000_000e18);
        assertEq(c.cashBps, 6000);
        assertEq(c.equityBps, 4000);
        uint256 fee = pc.feeFor(c.navUsd, PERIOD);
        // 1M x 0.25% x 30/365 = 205.479452 USDG
        assertEq(fee, 205_479452);

        vm.expectEmit(true, true, false, true, address(pc));
        emit PeriodClose.PeriodClosed(0, c.periodEnd, c, fee, fee, 0);
        _commit(c);

        PeriodClose.Close memory l = pc.latest();
        assertEq(keccak256(abi.encode(l)), keccak256(abi.encode(c)));
        assertEq(pc.closeCount(), 1);
        assertEq(usdg.balanceOf(feeTo), fee);
        assertEq(pc.periodStartNav(), c.navUsd - fee * 1e12);
        assertEq(pc.feeOwed(), 0);
    }

    function test_latestIsEmptyBeforeFirstClose() public view {
        PeriodClose.Close memory l = pc.latest();
        assertEq(l.periodEnd, 0);
        assertEq(l.navUsd, 0);
        assertEq(pc.periodStartNav(), 0);
    }

    function test_positionsHashMatchesIndependentRecompute() public {
        _warp(T0 + 1 hours);
        PeriodClose.Position[] memory exp = new PeriodClose.Position[](2);
        PeriodClose.Position memory u = PeriodClose.Position(address(usdg), FUNDING, 1e18, 1e18, 0);
        PeriodClose.Position memory a =
            PeriodClose.Position(address(aapl), SEED_AAPL, 200e18, aapl.uiMultiplier(), aaplFeed.latestRound());
        (exp[0], exp[1]) = address(usdg) < address(aapl) ? (u, a) : (a, u);
        (PeriodClose.Position[] memory got, bytes32 h,,,, address holdToken) = pc.preview();
        assertEq(holdToken, address(0));
        assertEq(got.length, 2);
        assertEq(h, keccak256(abi.encode(exp)));
    }

    function test_positionsSortedAndIncludeVaultPrice() public {
        _deposit(40_000e6);
        nvda.mint(address(account), 10e18);
        (PeriodClose.Position[] memory got,,,,,) = pc.preview();
        assertEq(got.length, 4);
        for (uint256 i = 1; i < got.length; ++i) assertLt(uint160(got[i - 1].asset), uint160(got[i].asset));
        for (uint256 i; i < got.length; ++i) {
            if (got[i].asset == address(vault)) assertEq(got[i].price, 1e18); // fresh vault: 1 share = 1 USDG
        }
    }

    // ------------------------------------------------------------ recomputation

    function test_revertTamperedNav() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        uint256 nav = c.navUsd;
        c.navUsd = nav + 1;
        bytes memory sig = _sign(c, controllerKey); // a validly signed lie still fails
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.NavMismatch.selector, nav, nav + 1));
        pc.commit(c, sig);
        c.navUsd = nav - 1;
        sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.NavMismatch.selector, nav, nav - 1));
        pc.commit(c, sig);
    }

    function test_revertNavClaimedAfterHoldingsLeft() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        vm.prank(board);
        account.withdrawToBoard(address(usdg), 1e6); // money leaves after the statement was built
        bytes memory sig = _sign(c, controllerKey);
        vm.expectPartialRevert(PeriodClose.NavMismatch.selector);
        pc.commit(c, sig);
    }

    function test_revertTamperedWeights() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        c.cashBps += 1;
        c.equityBps -= 1;
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.WeightsMismatch.selector, uint16(6000), uint16(4000)));
        pc.commit(c, sig);
    }

    function test_revertTamperedPositionsHash() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        bytes32 real = c.positionsHash;
        c.positionsHash = keccak256("fake");
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PositionsMismatch.selector, real));
        pc.commit(c, sig);
    }

    function test_revertFeedOnHold() public {
        vm.warp(T0 + PERIOD); // feeds not refreshed: AAPL (held) is stale
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.HoldAtClose.selector, address(aapl)));
        pc.commit(c, sig);
        (,,,,, address holdToken) = pc.preview();
        assertEq(holdToken, address(aapl));

        // Markets reopen: the same period closes.
        _warp(T0 + PERIOD + 2 days);
        c = _build(uint64(T0 + PERIOD));
        _commit(c);
        assertEq(pc.closeCount(), 1);
    }

    function test_staleFeedOfUnheldTokenDoesNotBlock() public {
        vm.warp(T0 + PERIOD);
        aaplFeed.setUpdatedAt(block.timestamp); // only the held token is fresh
        _commit(_build(uint64(T0 + PERIOD)));
        assertEq(pc.closeCount(), 1);
    }

    function test_heldDelistedTokenRecordedAtZeroAndDoesNotBlock() public {
        del.mint(address(account), 5e18);
        _warp(T0 + PERIOD);
        (PeriodClose.Position[] memory got,, uint256 nav,,, address holdToken) = pc.preview();
        assertEq(holdToken, address(0));
        assertEq(nav, 1_000_000e18); // delisted counts 0
        bool seen;
        for (uint256 i; i < got.length; ++i) {
            if (got[i].asset == address(del)) {
                seen = true;
                assertEq(got[i].price, 0);
                assertEq(got[i].raw, 5e18);
            }
        }
        assertTrue(seen);
        _commit(_build(uint64(T0 + PERIOD)));
    }

    // ------------------------------------------------------------ L-4: dust donations vs the signed close

    bytes constant COMMIT_SNAPSHOT_SIG =
        "commitSnapshot((uint64,uint256,uint16,uint16,bytes32,bytes32,bytes32,uint32),bytes)";

    /// L-4: the live commit recomputes NAV and positions at inclusion, so 1 wei of USDG sent to the account between
    /// signing and inclusion voids the signed Close. The controller's on-chain `snapshot()` pins the book at the
    /// period end; a Close signed over the snapshot commits whatever anyone sends afterwards.
    function test_poc_dustDonationCannotVoidSnapshotClose() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory live = _build(uint64(T0 + PERIOD));
        bytes memory liveSig = _sign(live, controllerKey);
        usdg.mint(address(account), 1); // the griefer's 1 wei
        vm.expectPartialRevert(PeriodClose.NavMismatch.selector);
        pc.commit(live, liveSig); // the live path still recomputes (and so can be griefed)

        vm.prank(controller);
        (bool ok,) = address(pc).call(abi.encodeWithSignature("snapshot()"));
        assertTrue(ok, "controller snapshot");
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD)); // == the snapshot (same block)
        bytes memory sig = _sign(c, controllerKey);
        usdg.mint(address(account), 1); // donations after the snapshot
        aapl.mint(address(account), 1);
        (ok,) = address(pc).call(abi.encodeWithSignature(string(COMMIT_SNAPSHOT_SIG), c, sig));
        assertTrue(ok, "commit against the snapshot");
        assertEq(pc.closeCount(), 1);
        assertEq(pc.latest().navUsd, c.navUsd);
    }

    function _snapshot() internal {
        vm.prank(controller);
        pc.snapshot();
    }

    function test_snapshotOnlyControllerAndNotBeforePeriodEnd() public {
        _warp(T0 + PERIOD);
        vm.expectRevert(PeriodClose.NotController.selector);
        vm.prank(board);
        pc.snapshot();
        _closeAfter(0); // first close at T0 + PERIOD
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PeriodInFuture.selector, uint64(T0 + 2 * PERIOD), block.timestamp));
        vm.prank(controller);
        pc.snapshot();
    }

    function test_snapshotRecordsTheBook() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        vm.expectEmit(address(pc));
        emit PeriodClose.BookSnapshotted(uint64(block.timestamp), c.positionsHash, c.navUsd, c.cashBps, c.equityBps);
        _snapshot();
        PeriodClose.BookSnapshot memory b = pc.bookSnapshot();
        assertEq(b.takenAt, block.timestamp);
        assertEq(b.navUsd, c.navUsd);
        assertEq(b.positionsHash, c.positionsHash);
        assertEq(b.bandUsd[0], 600_000e18);
        assertEq(b.bandUsd[1], 400_000e18);
    }

    function test_snapshotHoldsLikeCommit() public {
        vm.warp(T0 + PERIOD); // AAPL feed stale
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.HoldAtClose.selector, address(aapl)));
        vm.prank(controller);
        pc.snapshot();
    }

    function test_commitSnapshotChecksTheSnapshotNotTheLiveBook() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(PeriodClose.NoSnapshot.selector);
        pc.commitSnapshot(c, sig);
        _snapshot();
        vm.prank(board);
        account.withdrawToBoard(address(usdg), 100_000e6); // a real move after the snapshot: the statement is the snapshot
        PeriodClose.Close memory lie = _build(uint64(T0 + PERIOD)); // the live book: $900k
        assertEq(lie.navUsd, 900_000e18);
        bytes memory lieSig = _sign(lie, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.NavMismatch.selector, c.navUsd, lie.navUsd));
        pc.commitSnapshot(lie, lieSig);
        bytes memory badSig = _sign(c, uint256(keccak256("stranger"))); // test-key
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commitSnapshot(c, badSig);
        pc.commitSnapshot(c, sig);
        // review3 R3-TREAS-3: the start NAV is the checked statement (less the fee), never the live book, so a
        // withdrawal between snapshot and commit cannot lower the drawdown base.
        assertEq(pc.periodStartNav(), c.navUsd - pc.feeFor(c.navUsd, PERIOD) * 1e12, "start NAV is the statement");
        assertEq(pc.bookSnapshot().takenAt, 0, "consumed");
    }

    function test_commitSnapshotConsumedOnce() public {
        _warp(T0 + PERIOD);
        _snapshot();
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        pc.commitSnapshot(c, _sign(c, controllerKey));
        _warp(T0 + 2 * PERIOD);
        PeriodClose.Close memory c2 = _build(uint64(T0 + 2 * PERIOD));
        bytes memory sig2 = _sign(c2, controllerKey);
        vm.expectRevert(PeriodClose.NoSnapshot.selector);
        pc.commitSnapshot(c2, sig2);
    }

    function test_commitSnapshotBoundsAndPeriodEnd() public {
        _warp(T0 + PERIOD + 10);
        _snapshot();
        PeriodClose.Close memory late = _build(uint64(T0 + PERIOD + 11)); // periodEnd after the snapshot
        _warp(T0 + PERIOD + 11);
        bytes memory sig = _sign(late, controllerKey);
        vm.expectRevert(
            abi.encodeWithSelector(PeriodClose.SnapshotBeforePeriodEnd.selector, uint64(T0 + PERIOD + 10), late.periodEnd)
        );
        pc.commitSnapshot(late, sig);

        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        sig = _sign(c, controllerKey);
        _warp(T0 + PERIOD + 10 + pc.SNAPSHOT_MAX_AGE() + 1);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.SnapshotExpired.selector, uint64(T0 + PERIOD + 10)));
        pc.commitSnapshot(c, sig);
        _snapshot(); // the controller retakes it
        c = _build(uint64(T0 + PERIOD));
        pc.commitSnapshot(c, _sign(c, controllerKey));
        assertEq(pc.closeCount(), 1);
    }

    // ------------------------------------------------------------ signature + policy

    function test_revertBadSignature() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        bytes memory sig = _sign(c, uint256(keccak256("stranger"))); // test-key
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commit(c, sig);

        sig = _sign(c, controllerKey);
        c.bundleHash = keccak256("other bundle"); // signature does not cover the swapped bundle
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commit(c, sig);
    }

    function test_digestIsEip712() public view {
        PeriodClose.Close memory c = PeriodClose.Close(1, 2, 3, 4, bytes32(uint256(5)), bytes32(uint256(6)), bytes32(uint256(7)), 8);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Plynth PeriodClose"),
                keccak256("1"),
                block.chainid,
                address(pc)
            )
        );
        bytes32 structHash = keccak256(abi.encode(pc.CLOSE_TYPEHASH(), c));
        assertEq(pc.digest(c), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_revertPolicyMismatch() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        (, bytes32 h, uint32 v) = policy.current();
        c.policyVersion = v + 1;
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PolicyMismatch.selector, h, v));
        pc.commit(c, sig);

        c.policyVersion = v;
        c.policyHash = keccak256("other policy");
        sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PolicyMismatch.selector, h, v));
        pc.commit(c, sig);
    }

    /// The statement binds the policy in force at periodEnd and that version's controller, even if a newer
    /// policy (with a new controller) was activated before the commit.
    function test_policyVersionAtPeriodEnd() public {
        (address newCtl, uint256 newKey) = makeAddrAndKey("controller2"); // test-key
        TreasuryPolicy.Policy memory p = _policy();
        p.controller = newCtl;
        vm.prank(board);
        policy.propose(p);
        _warp(T0 + PERIOD + 1); // after periodEnd
        policy.activate(); // v2 active from now, i.e. after periodEnd
        _warp(block.timestamp + 1 hours);

        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        (, bytes32 h1,) = policy.policyAt(1);
        c.policyHash = h1;
        c.policyVersion = 1;
        bytes memory sigNew = _sign(c, newKey);
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commit(c, sigNew);
        _commit(c); // v1's controller signs
        assertEq(pc.latest().policyVersion, 1);

        // The next period ends under v2: v2's hash, v2's controller.
        _warp(T0 + 2 * PERIOD + 2 hours);
        c = _build(uint64(T0 + 2 * PERIOD + 2));
        assertEq(c.policyVersion, 2);
        bytes memory sigOld = _sign(c, controllerKey);
        vm.expectRevert(PeriodClose.BadSignature.selector);
        pc.commit(c, sigOld);
        pc.commit(c, _sign(c, newKey));
    }

    // ------------------------------------------------------------ timing

    function test_revertPeriodInFuture() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD + 1));
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PeriodInFuture.selector, uint64(T0 + PERIOD + 1), T0 + PERIOD));
        pc.commit(c, sig);
    }

    function test_revertSecondCloseTooEarly() public {
        _closeAfter(PERIOD);
        uint64 prev = pc.latest().periodEnd;
        assertEq(pc.nextPeriodEnd(), prev + PERIOD);
        _warp(prev + PERIOD - 1);
        PeriodClose.Close memory c = _build(uint64(prev + PERIOD - 1));
        bytes memory sig = _sign(c, controllerKey);
        vm.expectRevert(abi.encodeWithSelector(PeriodClose.PeriodTooEarly.selector, prev + PERIOD - 1, prev + PERIOD));
        pc.commit(c, sig);
        // Replaying the first statement is "too early" as well.
        PeriodClose.Close memory first = pc.latest();
        bytes memory firstSig = _sign(first, controllerKey);
        vm.expectPartialRevert(PeriodClose.PeriodTooEarly.selector);
        pc.commit(first, firstSig);

        _warp(prev + PERIOD);
        _commit(_build(uint64(prev + PERIOD)));
        assertEq(pc.closeCount(), 2);
    }

    function test_revertFirstCloseBeforeStart() public {
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 - 1));
        bytes memory sig = _sign(c, controllerKey);
        vm.expectPartialRevert(PeriodClose.PeriodTooEarly.selector);
        pc.commit(c, sig);
    }

    // ------------------------------------------------------------ fee

    function test_feeOwedCarriedWhenCashShort() public {
        vm.prank(board);
        account.withdrawToBoard(address(usdg), FUNDING); // only AAPL left: $400k, no idle cash
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        uint256 fee1 = pc.feeFor(c.navUsd, PERIOD);
        _commit(c);
        assertEq(pc.feeOwed(), fee1);
        assertEq(usdg.balanceOf(feeTo), 0);
        assertEq(pc.periodStartNav(), c.navUsd);

        usdg.mint(address(account), 1_000e6);
        _warp(T0 + 2 * PERIOD);
        c = _build(uint64(T0 + 2 * PERIOD));
        uint256 fee2 = pc.feeFor(c.navUsd, PERIOD);
        _commit(c);
        assertEq(usdg.balanceOf(feeTo), fee1 + fee2);
        assertEq(pc.feeOwed(), 0);
    }

    function test_zeroFeeRecipientMeansNoFee() public {
        PeriodClose free = new PeriodClose(account, IERC20Metadata(address(usdg)), address(0), ITierSource(address(0)));
        _replacePeriodClose(account, address(free));
        pc = free;
        _warp(T0 + PERIOD);
        PeriodClose.Close memory c = _build(uint64(T0 + PERIOD));
        _commit(c);
        assertEq(free.feeFor(c.navUsd, PERIOD), 0);
        assertEq(usdg.balanceOf(address(account)), FUNDING);
        assertEq(free.periodStartNav(), c.navUsd);
    }

    function test_payCloseFeeOnlyFromPeriodClose() public {
        vm.expectRevert(TreasuryAccount.NotPeriodClose.selector);
        vm.prank(board);
        account.payCloseFee(address(usdg), board, 1);
        vm.expectRevert(TreasuryAccount.NotPeriodClose.selector);
        account.payCloseFee(address(usdg), stranger, 1);
        vm.prank(board);
        vm.expectRevert(TreasuryAccount.ZeroAddress.selector); // never cleared once set
        account.setPeriodClose(address(0));
        vm.expectRevert(TreasuryAccount.NotPeriodClose.selector);
        vm.prank(address(0));
        account.payCloseFee(address(usdg), stranger, 1);
    }

    /// fee = navUsd x 25 bps x elapsed / 365 days, floored to USDG units.
    function testFuzz_feeMath(uint256 nav, uint256 elapsed) public view {
        nav = bound(nav, 0, 1e36); // up to $1e18
        elapsed = bound(elapsed, 0, 50 * 365 days);
        uint256 fee = pc.feeFor(nav, elapsed);
        uint256 exactUsd = nav * 25 * elapsed / (10_000 * 365 days);
        assertEq(fee, exactUsd / 1e12);
        // never more than the exact pro-rata fee, and short by under one USDG unit
        assertLe(fee * 1e12, nav * 25 * elapsed / (10_000 * 365 days));
        assertLt(exactUsd - fee * 1e12, 1e12);
        if (elapsed == 365 days) assertEq(fee, nav * 25 / 10_000 / 1e12); // 0.25% a year
        // monotonic in time
        if (elapsed > 0) assertLe(pc.feeFor(nav, elapsed - 1), fee);
    }

    function testFuzz_commitPaysFeeAndSetsStartNav(uint256 dt, uint256 extraCash) public {
        dt = bound(dt, 1, 3 * 365 days);
        extraCash = bound(extraCash, 0, 1e15 * 1e6);
        usdg.mint(address(account), extraCash);
        _warp(T0 + dt);
        PeriodClose.Close memory c = _build(uint64(T0 + dt));
        uint256 before = usdg.balanceOf(address(account));
        _commit(c);
        uint256 fee = pc.feeFor(c.navUsd, dt);
        assertEq(usdg.balanceOf(feeTo), fee);
        assertEq(usdg.balanceOf(address(account)), before - fee);
        assertEq(pc.periodStartNav(), c.navUsd - fee * 1e12);
    }

    // ------------------------------------------------------------ guard integration

    function test_drawdownRuleReadsCommittedStartNav() public {
        _closeAfter(PERIOD);
        uint256 start = pc.periodStartNav();
        assertGt(start, 0);
        // AAPL falls 25%: NAV ~ -10% from the period start -> derisk (only moves toward cash)
        aaplFeed.set(150e8);
        _expectCode(PolicyGuard(address(guard)).R8_DERISK());
        _buy(address(nvda), 1_000e6);
        _sell(address(aapl), 10e18); // toward cash is still allowed
    }
}
