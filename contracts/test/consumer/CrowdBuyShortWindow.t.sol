// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CrowdBuy, IExecuteBeacon} from "../../src/consumer/CrowdBuy.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";

/// The testnet settings: a 2 hour CrowdBuy window on a beacon with a 15 minute GRACE. Commit before the
/// window, reveal at the execution time, execute, all inside one window; the next window works the same way.
contract CrowdBuyShortWindowTest is CrowdBuyBase {
    bytes32 constant SECRET = keccak256("short");

    function _window() internal pure override returns (uint64) {
        return 2 hours;
    }

    function _grace() internal pure override returns (uint64) {
        return 15 minutes;
    }

    function test_window_isTheDeployParam() public view {
        assertEq(crowd.WINDOW(), 2 hours);
        assertEq(beacon.GRACE(), 15 minutes);
        (uint64 s, uint64 e) = crowd.windowOf(GENESIS + 2 hours + 1);
        assertEq(s, GENESIS + 2 hours);
        assertEq(e, GENESIS + 4 hours);
    }

    function testFuzz_window_gridContainsT(uint64 dt) public view {
        uint256 t = GENESIS + uint256(dt % 3650 days);
        (uint64 s, uint64 e) = crowd.windowOf(t);
        assertLe(s, t);
        assertLt(t, e);
        assertEq(e - s, 2 hours);
        assertEq((s - GENESIS) % 2 hours, 0);
    }

    function test_window_boundsAtDeploy() public {
        vm.expectRevert(CrowdBuy.BadWindow.selector);
        new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, SLIP, GENESIS, owner, keeper, 1 hours - 1);
        vm.expectRevert(CrowdBuy.BadWindow.selector);
        new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, SLIP, GENESIS, owner, keeper, 0);
        CrowdBuy c = new CrowdBuy(vault, router, IExecuteBeacon(address(beacon)), 3, SLIP, GENESIS, owner, keeper, 1 hours);
        assertEq(c.WINDOW(), 1 hours);
    }

    /// A window must be longer than the beacon's GRACE (mainnet beacon: 1 hour).
    function test_window_mustExceedBeaconGrace() public {
        vm.prank(owner);
        address mainBeacon = address(new JitterBeaconLike(2 hours));
        vm.expectRevert(CrowdBuy.BadWindow.selector);
        new CrowdBuy(vault, router, IExecuteBeacon(mainBeacon), 3, SLIP, GENESIS, owner, keeper, 2 hours);
        new CrowdBuy(vault, router, IExecuteBeacon(mainBeacon), 3, SLIP, GENESIS, owner, keeper, 2 hours + 1);
    }

    function test_commitRevealExecute_insideOneTwoHourWindow() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS);
        uint64 at = _reveal(address(tokA), 0, SECRET);
        assertLt(at, GENESIS + 2 hours - 15 minutes, "execution time inside [start, end - GRACE)");
        _freshFeeds();
        _executeAsKeeper(address(tokA));
        assertTrue(crowd.book(address(tokA), 0).executed);
        assertLt(block.timestamp, GENESIS + 2 hours);

        // The next 2 h window: a new book, a new beacon, a second execution the same day.
        for (uint256 i = 3; i < 6; ++i) _joinA(_user(i), 10 * U);
        _commit(address(tokA), 1, SECRET);
        vm.warp(GENESIS + 2 hours);
        at = _reveal(address(tokA), 1, SECRET);
        _freshFeeds();
        _executeAsKeeper(address(tokA));
        assertTrue(crowd.book(address(tokA), 1).executed);
        assertLt(block.timestamp, GENESIS + 4 hours);
    }

    function test_unrevealedFallsBackToWindowEndMinusShortGrace() public {
        for (uint256 i; i < 3; ++i) _joinA(_user(i), 10 * U);
        _commit(address(tokA), 0, SECRET);
        uint64 fallbackAt = GENESIS + 2 hours - 15 minutes;
        vm.warp(fallbackAt - 1);
        _freshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.TooEarly.selector, fallbackAt));
        _executeAsKeeper(address(tokA));
        vm.warp(fallbackAt);
        _freshFeeds();
        address stranger = makeAddr("stranger");
        vm.prank(stranger); // permissionless from windowEnd - GRACE
        crowd.execute(address(tokA));
        assertTrue(crowd.book(address(tokA), 0).executed);
    }
}

/// Minimal beacon stand-in with a configurable GRACE (for the window > GRACE check only).
contract JitterBeaconLike {
    uint64 public immutable GRACE;

    constructor(uint64 g) {
        GRACE = g;
    }

    function executeAfter(bytes32) external pure returns (uint64) {
        return type(uint64).max;
    }
}
