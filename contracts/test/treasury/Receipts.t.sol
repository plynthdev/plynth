// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {Receipts} from "../../src/treasury/Receipts.sol";
import {TreasuryPolicy} from "../../src/treasury/TreasuryPolicy.sol";
import {TreasuryFixture} from "./TreasuryFixture.sol";

/// Todo 30: hourly receipts. Only the treasury's current controller posts, only for a finished hour, once; any
/// leaf of the posted tree verifies and nothing else does. The tree here is the same one the receipts service
/// builds (sorted-pair keccak, an odd node is carried up unchanged).
contract ReceiptsTest is TreasuryFixture {
    Receipts rc;
    uint64 hour;

    function setUp() public override {
        super.setUp();
        rc = new Receipts();
        hour = uint64(block.timestamp / 1 hours) - 1; // the last finished hour
    }

    // ------------------------------------------------------------ tree helpers (mirror apps/treasury/receipts)

    function _root(bytes32[] memory level) internal pure returns (bytes32) {
        if (level.length == 0) return bytes32(0);
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? Hashes.commutativeKeccak256(level[i], level[i + 1]) : level[i];
            }
            level = next;
        }
        return level[0];
    }

    function _proof(bytes32[] memory level, uint256 idx) internal pure returns (bytes32[] memory out) {
        bytes32[] memory tmp = new bytes32[](32);
        uint256 n;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[n++] = level[sib];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? Hashes.commutativeKeccak256(level[i], level[i + 1]) : level[i];
            }
            level = next;
            idx /= 2;
        }
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    function _leaves(uint256 n, uint256 seed) internal view returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i; i < n; ++i) l[i] = rc.leafOf(keccak256(abi.encode(seed, i)));
    }

    // ------------------------------------------------------------ rules

    function test_controllerPostsAFinishedHourOnce() public {
        bytes32[] memory l = _leaves(3, 1);
        bytes32 r = _root(l);
        vm.expectEmit(address(rc));
        emit Receipts.ReceiptPosted(address(account), hour, r, 3, controller);
        vm.prank(controller);
        rc.post(address(account), hour, r, 3);
        Receipts.Receipt memory got = rc.receipt(address(account), hour);
        assertEq(got.root, r);
        assertEq(got.leafCount, 3);
        assertEq(got.postedAt, block.timestamp);
        assertEq(rc.lastHour(address(account)), hour);
        vm.prank(controller);
        vm.expectRevert(abi.encodeWithSelector(Receipts.AlreadyPosted.selector, hour));
        rc.post(address(account), hour, keccak256("other"), 1);
    }

    function test_onlyTheCurrentControllerPosts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Receipts.NotController.selector, controller));
        rc.post(address(account), hour, keccak256("x"), 1);
        vm.prank(board); // not even the board
        vm.expectRevert(abi.encodeWithSelector(Receipts.NotController.selector, controller));
        rc.post(address(account), hour, keccak256("x"), 1);

        // A new policy with a new controller takes over once active; the old key is out.
        address next = makeAddr("nextController");
        TreasuryPolicy.Policy memory p = _policy();
        p.controller = next;
        vm.prank(board);
        policy.propose(p);
        vm.warp(block.timestamp + policy.TIMELOCK());
        policy.activate();
        uint64 h = uint64(block.timestamp / 1 hours) - 1;
        vm.prank(controller);
        vm.expectRevert(abi.encodeWithSelector(Receipts.NotController.selector, next));
        rc.post(address(account), h, keccak256("x"), 1);
        vm.prank(next);
        rc.post(address(account), h, keccak256("x"), 1);
    }

    function test_currentOrFutureHourRejected() public {
        uint64 nowHour = uint64(block.timestamp / 1 hours);
        vm.startPrank(controller);
        vm.expectRevert(abi.encodeWithSelector(Receipts.HourNotOver.selector, nowHour));
        rc.post(address(account), nowHour, keccak256("x"), 1);
        vm.expectRevert(abi.encodeWithSelector(Receipts.HourNotOver.selector, nowHour + 5));
        rc.post(address(account), nowHour + 5, keccak256("x"), 1);
        vm.warp((uint256(nowHour) + 1) * 1 hours); // the hour just ended
        rc.post(address(account), nowHour, keccak256("x"), 1);
        vm.stopPrank();
    }

    function test_rootAndLeafCountMustAgree() public {
        vm.startPrank(controller);
        vm.expectRevert(Receipts.BadRoot.selector);
        rc.post(address(account), hour, bytes32(0), 1);
        vm.expectRevert(Receipts.BadRoot.selector);
        rc.post(address(account), hour, keccak256("x"), 0);
        rc.post(address(account), hour, bytes32(0), 0); // an empty hour, posted so it is not "skipped"
        vm.stopPrank();
        assertFalse(rc.verify(address(account), hour, bytes32(0), new bytes32[](0)));
    }

    function test_backfillDoesNotMoveLastHourBack() public {
        vm.startPrank(controller);
        rc.post(address(account), hour, keccak256("x"), 1);
        rc.post(address(account), hour - 3, keccak256("y"), 1);
        vm.stopPrank();
        assertEq(rc.lastHour(address(account)), hour);
    }

    function test_unpostedHourVerifiesNothing() public view {
        assertFalse(rc.verify(address(account), hour, keccak256("x"), new bytes32[](0)));
    }

    /// Any tree size: every leaf verifies at its index, a foreign leaf and a leaf of another hour do not.
    function testFuzz_everyLeafVerifies(uint8 n, uint256 seed, uint256 pick) public {
        n = uint8(bound(n, 1, 40));
        bytes32[] memory l = _leaves(n, seed);
        bytes32 r = _root(l);
        vm.prank(controller);
        rc.post(address(account), hour, r, n);
        uint256 i = pick % n;
        bytes32[] memory pr = _proof(l, i);
        assertTrue(rc.verify(address(account), hour, l[i], pr));
        assertFalse(rc.verify(address(account), hour, rc.leafOf(keccak256(abi.encode(seed, uint256(n)))), pr));
        assertFalse(rc.verify(address(account), hour - 1, l[i], pr));
        if (n > 1) assertFalse(rc.verify(address(account), hour, l[(i + 1) % n], pr));
    }
}
