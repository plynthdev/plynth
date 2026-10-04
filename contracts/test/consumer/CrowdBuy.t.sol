// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IExecuteBeacon} from "../../src/consumer/CrowdBuy.sol";
import {StockRouter} from "../../src/core/StockRouter.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

contract CrowdBuyTest is CrowdBuyBase {
    bytes32 constant SECRET = keccak256("s");

    /// Three users join A (10, 20, 30 USDG), window 0 committed and revealed, time moved to the beacon time.
    function _readyBook() internal returns (address[] memory users, uint64 at) {
        users = new address[](3);
        for (uint256 i; i < 3; ++i) {
            users[i] = _user(i);
            _joinA(users[i], (i + 1) * 10 * U);
        }
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS);
        at = _reveal(address(tokA), 0, SECRET);
        vm.warp(at);
        _freshFeeds();
    }

    // ---------------------------------------------------------------- R1

    function test_R1_executeRevertsBelowMinCrowd() public {
        _joinA(_user(0), 10 * U);
        _joinA(_user(1), 10 * U);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS + 1 days - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.CrowdTooSmall.selector, uint32(2), uint32(3)));
        crowd.execute(address(tokA));
    }

    function test_R1_executeRevertsBeforeBeaconTime() public {
        (, uint64 at) = _readyBook();
        vm.warp(at - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.TooEarly.selector, at));
        crowd.execute(address(tokA));
        vm.warp(at);
        _freshFeeds();
        crowd.execute(address(tokA));
    }

    function test_R1_unrevealedBeaconFallsBackToWindowEndMinusGrace() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        _commit(address(tokA), 0, SECRET);
        uint64 fallbackAt = GENESIS + 1 days - 1 hours;
        vm.warp(fallbackAt - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.TooEarly.selector, fallbackAt));
        crowd.execute(address(tokA));
        vm.warp(fallbackAt);
        _freshFeeds();
        crowd.execute(address(tokA));
    }

    function test_R1_executeRevertsWithoutCommit() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        vm.warp(GENESIS + 1 days - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.TooEarly.selector, type(uint64).max));
        crowd.execute(address(tokA));
    }

    function test_R1_executeRevertsWhenValuerOnHold() public {
        _readyBook();
        feedA.setUpdatedAt(block.timestamp - 2 hours - 1); // feed stale (off-hours)
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.MarketOnHold.selector, address(tokA)));
        crowd.execute(address(tokA));
    }

    function test_R1_executeRevertsBeforeGenesis() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        vm.expectRevert(CrowdBuy.BeforeGenesis.selector);
        crowd.execute(address(tokA));
    }

    function test_R1_atMostOneExecutionPerWindow() public {
        _readyBook();
        crowd.execute(address(tokA));
        for (uint256 i = 3; i < 6; ++i) _joinA(_user(i), 10 * U);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.AlreadyExecutedThisWindow.selector, GENESIS));
        crowd.execute(address(tokA));
    }

    function test_R1_bookRollsIntoNextWindowWhenCrowdTooSmall() public {
        _joinA(_user(0), 10 * U);
        _joinA(_user(1), 10 * U);
        _commit(address(tokA), 0, SECRET);
        _commit(address(tokA), 1, SECRET);
        vm.warp(GENESIS + 1 days - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.CrowdTooSmall.selector, uint32(2), uint32(3)));
        crowd.execute(address(tokA));

        // Window 1: same book, third user arrives, executes at window 1's beacon time.
        vm.warp(_windowStart(1));
        _joinA(_user(2), 10 * U);
        (uint256 id, CrowdBuy.Book memory b) = crowd.openBook(address(tokA));
        assertEq(id, 0);
        assertEq(b.accounts, 3);
        assertEq(b.openedAt, T0);
        uint64 at = _reveal(address(tokA), 1, SECRET);
        vm.warp(at);
        _freshFeeds();
        crowd.execute(address(tokA));
        assertTrue(crowd.book(address(tokA), 0).executed);
    }

    function test_R1_minCrowdIsAConstructorParam() public {
        vm.expectRevert(CrowdBuy.BadParam.selector);
        new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 0, SLIP, GENESIS, owner, keeper);
        CrowdBuy c = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 20, SLIP, GENESIS, owner, keeper);
        assertEq(c.MIN_CROWD(), 20);
    }

    function test_R1_windowGridIsFixed24h() public view {
        (uint64 s, uint64 e) = crowd.windowOf(GENESIS);
        assertEq(s, GENESIS);
        assertEq(e, GENESIS + 1 days);
        (s, e) = crowd.windowOf(GENESIS + 3 days + 5 hours);
        assertEq(s, GENESIS + 3 days);
        assertEq(e, GENESIS + 4 days);
        (s,) = crowd.windowOf(GENESIS + 1 days - 1);
        assertEq(s, GENESIS);
    }

    function testFuzz_R1_windowOfContainsT(uint64 dt) public view {
        uint256 t = uint256(GENESIS) + bound(dt, 0, 100 * 365 days);
        (uint64 s, uint64 e) = crowd.windowOf(t);
        assertLe(s, t);
        assertLt(t, e);
        assertEq(e - s, 1 days);
        assertEq((s - GENESIS) % 1 days, 0);
    }

    // ---------------------------------------------------------------- R2

    function test_R2_slippageCapAt300Bps() public {
        vm.expectRevert(CrowdBuy.BadParam.selector);
        new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, 301, GENESIS, owner, keeper);
        CrowdBuy c = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, 300, GENESIS, owner, keeper);
        assertEq(c.slippageBps(), 300);
    }

    function test_R2_routerEnforcesOracleMinOutAndBookStaysOpen() public {
        _readyBook();
        _setPool(address(tokA), PRICE_A * 105 / 100); // pool 5% worse than oracle, cap is 1%
        vm.expectPartialRevert(StockRouter.Slippage.selector);
        crowd.execute(address(tokA));
        (uint256 id, CrowdBuy.Book memory b) = crowd.openBook(address(tokA));
        assertEq(id, 0);
        assertFalse(b.executed);
        assertEq(usdg.balanceOf(address(crowd)), 60 * U);
    }

    // ---------------------------------------------------------------- R3

    function test_R3_allocationIsFloorOfProRata() public {
        (address[] memory users,) = _readyBook();
        crowd.execute(address(tokA));
        CrowdBuy.Book memory b = crowd.book(address(tokA), 0);
        assertEq(b.usdgTotal, 60 * U);
        for (uint256 i; i < 3; ++i) {
            assertEq(crowd.allocationOf(address(tokA), 0, users[i]), b.rawOut * ((i + 1) * 10 * U) / (60 * U));
        }
    }

    function testFuzz_R3_sumOfAllocationsPlusDustEqualsRawOut(uint256 seed, uint8 n) public {
        uint256 count = bound(n, 3, 12);
        address[] memory users = new address[](count);
        for (uint256 i; i < count; ++i) {
            users[i] = _user(i);
            _joinA(users[i], bound(uint256(keccak256(abi.encode(seed, i))), 1, 400 * U));
        }
        _setPool(address(tokA), PRICE_A - (seed % 1e18)); // odd rates make dust likely
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS + 1 days - 1 hours);
        _freshFeeds();
        crowd.execute(address(tokA));
        CrowdBuy.Book memory b = crowd.book(address(tokA), 0);

        uint256 sum;
        for (uint256 i; i < count; ++i) {
            uint256 before = tokA.balanceOf(users[i]);
            vm.prank(users[i]);
            crowd.claimOpen(address(tokA), 0);
            uint256 got = tokA.balanceOf(users[i]) - before;
            assertEq(got, crowd.allocationOf(address(tokA), 0, users[i]));
            sum += got;
        }
        assertEq(sum + crowd.dust(address(tokA)), b.rawOut, "sum + dust == rawOut");
        assertLt(crowd.dust(address(tokA)), count, "dust < accounts");
        assertEq(tokA.balanceOf(address(crowd)), crowd.dust(address(tokA)));
    }

    function test_R3_dustOnlySettlesWhenLastAccountSettles() public {
        (address[] memory users,) = _readyBook();
        crowd.execute(address(tokA));
        vm.prank(users[0]);
        crowd.claimOpen(address(tokA), 0);
        vm.prank(users[1]);
        crowd.claimOpen(address(tokA), 0);
        assertEq(crowd.dust(address(tokA)), 0);
        vm.prank(users[2]);
        crowd.claimOpen(address(tokA), 0);
        CrowdBuy.Settlement memory s = crowd.settlement(address(tokA), 0);
        assertEq(s.settledAccounts, 3);
        assertEq(s.settledRaw + crowd.dust(address(tokA)), crowd.book(address(tokA), 0).rawOut);
    }

    // ---------------------------------------------------------------- R4

    function testFuzz_R4_multiplierChangeAfterExecuteDoesNotChangeAllocation(uint256 m) public {
        (address[] memory users,) = _readyBook();
        crowd.execute(address(tokA));
        uint256 a0 = crowd.allocationOf(address(tokA), 0, users[0]);
        tokA.setMultiplier(bound(m, 1, 100e18));
        assertEq(crowd.allocationOf(address(tokA), 0, users[0]), a0);
        uint256 before = tokA.balanceOf(users[0]);
        vm.prank(users[0]);
        crowd.claimOpen(address(tokA), 0);
        assertEq(tokA.balanceOf(users[0]) - before, a0, "raw units, not scaled");
    }

    // ---------------------------------------------------------------- R5

    function test_R5_accountsCountsDistinctUsers() public {
        address u = _user(0);
        _joinA(u, 10 * U);
        _accrue(u, 5 * U);
        crowd.join(u); // same user again
        (, CrowdBuy.Book memory b) = crowd.openBook(address(tokA));
        assertEq(b.accounts, 1);
        assertEq(b.usdgTotal, 15 * U);
        assertEq(crowd.orderOf(address(tokA), 0, u), 15 * U);
        _joinA(_user(1), 1);
        (, b) = crowd.openBook(address(tokA));
        assertEq(b.accounts, 2);
    }

    function test_R5_cancelToZeroDecrementsAndRefunds() public {
        address u = _user(0);
        _joinA(u, 10 * U);
        _joinA(_user(1), 7 * U);
        vm.prank(u);
        crowd.cancel(address(tokA), 0);
        (, CrowdBuy.Book memory b) = crowd.openBook(address(tokA));
        assertEq(b.accounts, 1);
        assertEq(b.usdgTotal, 7 * U);
        assertEq(crowd.orderOf(address(tokA), 0, u), 0);
        (uint256 avail, uint256 pend) = vault.balancesOf(u);
        assertEq(avail, 10 * U);
        assertEq(pend, 0);
        assertEq(usdg.balanceOf(address(crowd)), 7 * U);
        // rejoining counts again
        _accrue(u, 2 * U);
        crowd.join(u);
        (, b) = crowd.openBook(address(tokA));
        assertEq(b.accounts, 2);
    }

    function test_R5_cancelOnlyOwnOrderAndOnlyBeforeExecution() public {
        (address[] memory users,) = _readyBook();
        vm.prank(_user(99));
        vm.expectRevert(CrowdBuy.NoOrder.selector);
        crowd.cancel(address(tokA), 0);
        crowd.execute(address(tokA));
        vm.prank(users[0]);
        vm.expectRevert(CrowdBuy.AlreadyExecuted.selector);
        crowd.cancel(address(tokA), 0);
    }

    // ---------------------------------------------------------------- R6

    function test_R6_claimOnlyOnce() public {
        (address[] memory users,) = _readyBook();
        crowd.execute(address(tokA));
        vm.startPrank(users[0]);
        crowd.claimOpen(address(tokA), 0);
        vm.expectRevert(CrowdBuy.AlreadySettled.selector);
        crowd.claimOpen(address(tokA), 0);
        vm.stopPrank();
    }

    function test_R6_claimBeforeExecutionOrWithoutOrderReverts() public {
        (address[] memory users,) = _readyBook();
        vm.prank(users[0]);
        vm.expectRevert(CrowdBuy.NotExecuted.selector);
        crowd.claimOpen(address(tokA), 0);
        crowd.execute(address(tokA));
        vm.prank(_user(99));
        vm.expectRevert(CrowdBuy.NoOrder.selector);
        crowd.claimOpen(address(tokA), 0);
    }

    function test_R6_deliverIsKeeperOnlyAndRejectsUnknownRoutes() public {
        (address[] memory users,) = _readyBook();
        crowd.execute(address(tokA));
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.deliver(address(tokA), 0, users[0], abi.encode(uint8(1)));
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.UnknownRoute.selector, bytes("")));
        crowd.deliver(address(tokA), 0, users[0], "");
        // Hidden (2) is todo 16
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.UnknownRoute.selector, abi.encode(uint8(2))));
        crowd.deliver(address(tokA), 0, users[0], abi.encode(uint8(2)));
        // Quiet before StealthClaims is configured
        vm.expectRevert(CrowdBuy.QuietNotConfigured.selector);
        crowd.deliver(address(tokA), 0, users[0], abi.encode(uint8(1)));
        vm.stopPrank();
        // a failed delivery leaves the allocation claimable
        vm.prank(users[0]);
        crowd.claimOpen(address(tokA), 0);
    }

    // ---------------------------------------------------------------- R7

    function test_R7_quietAndHiddenUsersCanClaimOpen() public {
        (address[] memory users,) = _readyBook();
        vm.prank(users[0]);
        vault.setSettings(SavingsVault.Settings(10, 1, uint64(500 * U), 0, 1)); // Quiet
        vm.prank(users[1]);
        vault.setSettings(SavingsVault.Settings(10, 1, uint64(500 * U), 0, 2)); // Hidden
        crowd.execute(address(tokA));
        vm.prank(owner);
        crowd.setKeeper(address(0)); // even with no keeper
        for (uint256 i; i < 2; ++i) {
            uint256 a = crowd.allocationOf(address(tokA), 0, users[i]);
            assertGt(a, 0);
            vm.prank(users[i]);
            crowd.claimOpen(address(tokA), 0);
            assertEq(tokA.balanceOf(users[i]), a);
        }
    }

    // ---------------------------------------------------------------- R8

    function test_R8_newBookOpensImmediatelyAfterExecution() public {
        _readyBook();
        crowd.execute(address(tokA));
        (uint256 id, CrowdBuy.Book memory b) = crowd.openBook(address(tokA));
        assertEq(id, 1);
        assertEq(b.openedAt, block.timestamp);
        assertEq(b.accounts, 0);
        address u = _user(7);
        _joinA(u, 4 * U);
        assertEq(crowd.orderOf(address(tokA), 1, u), 4 * U);
        assertEq(crowd.orderOf(address(tokA), 0, u), 0);
    }

    function test_R8_joinDuringExecutionLandsInNewBook() public {
        _readyBook();
        address late = _user(8);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(late, a, w, 9 * U);
        tokA.arm(crowd, late); // joins when the swap output reaches CrowdBuy
        crowd.execute(address(tokA));
        assertEq(tokA.hookUser(), address(0), "hook fired");
        assertEq(crowd.orderOf(address(tokA), 0, late), 0);
        assertEq(crowd.orderOf(address(tokA), 1, late), 9 * U);
        assertEq(crowd.book(address(tokA), 0).usdgTotal, 60 * U);
        assertEq(usdg.balanceOf(address(crowd)), 9 * U);
    }

    // ---------------------------------------------------------------- join

    function test_join_splitsByMixExactly() public {
        address u = _user(0);
        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        (t[0], t[1], w[0], w[1]) = (address(tokA), address(tokB), 3333, 6667);
        _prepare(u, t, w, 10 * U + 1);
        vm.prank(_user(50)); // anyone may call
        crowd.join(u);
        uint256 a = crowd.orderOf(address(tokA), 0, u);
        uint256 b = crowd.orderOf(address(tokB), 0, u);
        assertEq(a, (10 * U + 1) * 3333 / 10_000);
        assertEq(a + b, 10 * U + 1);
        assertEq(usdg.balanceOf(address(crowd)), 10 * U + 1);
    }

    function test_join_nothingPendingReverts() public {
        vm.expectRevert(CrowdBuy.NothingPending.selector);
        crowd.join(_user(0));
    }

    function test_onlyOwnerSetsKeeper() public {
        vm.expectRevert();
        crowd.setKeeper(address(this));
    }

    // ---------------------------------------------------------------- events

    function test_events() public {
        address u = _user(0);
        (address[] memory a, uint16[] memory w) = _one(address(tokA));
        _prepare(u, a, w, 10 * U);
        vm.expectEmit(address(crowd));
        emit CrowdBuy.Joined(address(tokA), 0, u, 10 * U);
        crowd.join(u);
        _joinA(_user(1), 10 * U);
        _joinA(_user(2), 10 * U);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS + 1 days - 1 hours);
        _freshFeeds();
        (uint80 roundId,,,,) = feedA.latestRoundData();
        vm.recordLogs();
        crowd.execute(address(tokA));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == CrowdBuy.Executed.selector) {
                (uint256 total, uint256 rawOut, uint32 accounts, uint80 rid) =
                    abi.decode(logs[i].data, (uint256, uint256, uint32, uint80));
                assertEq(total, 30 * U);
                assertEq(rawOut, crowd.book(address(tokA), 0).rawOut);
                assertEq(accounts, 3);
                assertEq(rid, roundId);
                found = true;
            }
        }
        assertTrue(found);
        uint256 alloc = crowd.allocationOf(address(tokA), 0, u);
        vm.expectEmit(address(crowd));
        emit CrowdBuy.Claimed(address(tokA), 0, u, alloc);
        vm.prank(u);
        crowd.claimOpen(address(tokA), 0);

        address c = _user(3);
        _joinA(c, 1 * U);
        vm.expectEmit(address(crowd));
        emit CrowdBuy.Cancelled(address(tokA), 1, c, 1 * U);
        vm.prank(c);
        crowd.cancel(address(tokA), 1);
    }
}
