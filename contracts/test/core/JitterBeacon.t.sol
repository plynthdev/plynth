// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";

contract JitterBeaconTest is Test {
    JitterBeacon beacon;
    address keeper = makeAddr("keeper");
    address board = makeAddr("board");
    address anyone = makeAddr("anyone");

    bytes32 constant KEY = keccak256("crowd-epoch-1");
    bytes32 constant SECRET = keccak256("keeper secret");
    uint64 start;
    uint64 end;

    function setUp() public {
        vm.warp(1_800_000_000);
        beacon = new JitterBeacon(keeper, board);
        start = uint64(block.timestamp + 1 days);
        end = start + 6 hours;
    }

    function _commit(bytes32 key, bytes32 secret) internal {
        vm.prank(keeper);
        beacon.commit(key, start, end, keccak256(abi.encode(secret, key)));
    }

    function test_happyPath() public {
        _commit(KEY, SECRET);
        assertEq(beacon.executeAfter(KEY), end - 1 hours, "before reveal = fallback");
        uint64 expected =
            start + uint64(uint256(keccak256(abi.encode(beacon.OFFSET_TAG(), SECRET, KEY))) % (end - start - 1 hours));
        vm.warp(expected);
        vm.prank(anyone);
        beacon.reveal(KEY, SECRET);
        assertEq(beacon.executeAfter(KEY), expected);
        assertLt(beacon.executeAfter(KEY), end - 1 hours);
    }

    function test_unknownKeyIsMax() public view {
        assertEq(beacon.executeAfter(KEY), type(uint64).max);
    }

    function test_wrongSecretReverts() public {
        _commit(KEY, SECRET);
        vm.warp(start);
        vm.expectRevert(JitterBeacon.WrongSecret.selector);
        beacon.reveal(KEY, keccak256("guess"));
    }

    function test_lateRevealRevertsAndFallbackHolds() public {
        _commit(KEY, SECRET);
        vm.warp(end - 1 hours);
        vm.expectRevert(JitterBeacon.RevealTooLate.selector);
        beacon.reveal(KEY, SECRET);
        assertEq(beacon.executeAfter(KEY), end - 1 hours);
    }

    function test_doubleCommitReverts() public {
        _commit(KEY, SECRET);
        vm.expectRevert(abi.encodeWithSelector(JitterBeacon.AlreadyCommitted.selector, KEY));
        _commit(KEY, keccak256("other"));
    }

    function test_doubleRevealReverts() public {
        _commit(KEY, SECRET);
        vm.warp(start + beacon.offsetOf(SECRET, KEY, start, end));
        beacon.reveal(KEY, SECRET);
        vm.expectRevert(abi.encodeWithSelector(JitterBeacon.AlreadyRevealed.selector, KEY));
        beacon.reveal(KEY, SECRET);
    }

    function test_revealBeforeWindowReverts() public {
        _commit(KEY, SECRET);
        vm.warp(start - 1);
        vm.expectRevert(JitterBeacon.WindowNotStarted.selector);
        beacon.reveal(KEY, SECRET);
    }

    function test_revealUnknownKeyReverts() public {
        vm.expectRevert(abi.encodeWithSelector(JitterBeacon.UnknownKey.selector, KEY));
        beacon.reveal(KEY, SECRET);
    }

    function test_commitOnlyKeeper() public {
        vm.expectRevert(JitterBeacon.NotKeeper.selector);
        vm.prank(anyone);
        beacon.commit(KEY, start, end, bytes32(uint256(1)));
    }

    function test_commitMustPrecedeWindow() public {
        vm.warp(start);
        vm.expectRevert(JitterBeacon.WindowAlreadyStarted.selector);
        vm.prank(keeper);
        beacon.commit(KEY, start, end, bytes32(uint256(1)));
    }

    function test_windowMustExceedGrace() public {
        vm.startPrank(keeper);
        vm.expectRevert(JitterBeacon.WindowTooShort.selector);
        beacon.commit(KEY, start, start + 1 hours, bytes32(uint256(1)));
        vm.expectRevert(JitterBeacon.WindowTooShort.selector);
        beacon.commit(KEY, start, start - 1, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_setKeeperOnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vm.prank(anyone);
        beacon.setKeeper(anyone);
        vm.prank(board);
        beacon.setKeeper(anyone);
        assertEq(beacon.keeper(), anyone);
    }

    function testFuzz_offsetInsideWindow(bytes32 secret, bytes32 key, uint64 len, uint64 wait) public {
        len = uint64(bound(len, 1 hours + 1, 365 days));
        uint64 s = uint64(block.timestamp) + uint64(bound(wait, 1, 30 days));
        uint64 e = s + len;
        vm.prank(keeper);
        beacon.commit(key, s, e, keccak256(abi.encode(secret, key)));
        vm.warp(s + beacon.offsetOf(secret, key, s, e));
        beacon.reveal(key, secret);
        uint64 at = beacon.executeAfter(key);
        assertGe(at, s);
        assertLt(at, e - 1 hours);
        assertLt(beacon.offsetOf(secret, key, s, e), len - 1 hours);
    }

    // ------------------------------------------------------------ S5 (security review 2026-10-06)

    /// The Committed event publishes the commitment; the execution time must not be computable from it.
    function test_S5_executeAtNotDerivableFromCommitment() public view {
        for (uint256 i; i < 8; ++i) {
            bytes32 secret = keccak256(abi.encode("secret", i));
            bytes32 commitment = keccak256(abi.encode(secret, KEY));
            uint64 fromCommitment = uint64(uint256(commitment) % (end - start - 1 hours));
            assertTrue(beacon.offsetOf(secret, KEY, start, end) != fromCommitment, "offset leaks from the commitment");
        }
    }

    /// Revealing publishes the time; it may happen only once that time has come.
    function test_S5_revealOnlyAtOrAfterExecuteAt() public {
        _commit(KEY, SECRET);
        uint64 at = start + beacon.offsetOf(SECRET, KEY, start, end);
        vm.assume(at > start);
        vm.warp(start);
        vm.expectRevert(abi.encodeWithSelector(JitterBeacon.RevealTooEarly.selector, at));
        beacon.reveal(KEY, SECRET);
        vm.warp(at);
        beacon.reveal(KEY, SECRET);
        assertEq(beacon.executeAfter(KEY), at);
    }
}
