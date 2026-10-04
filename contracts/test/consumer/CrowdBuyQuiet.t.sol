// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {StealthClaims} from "../../src/consumer/StealthClaims.sol";
import {IERC5564Announcer} from "../../src/interfaces/IERC5564Announcer.sol";
import {IERC6538Registry} from "../../src/interfaces/IERC6538Registry.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";
import {StealthCode} from "./StealthCode.sol";

/// Quiet delivery through CrowdBuy against the real ERC-5564 Announcer and ERC-6538 Registry bytecode.
contract CrowdBuyQuietTest is CrowdBuyBase {
    bytes32 constant SECRET = keccak256("q");
    bytes constant QUIET = abi.encode(uint8(1));
    // A syntactically valid compressed secp256k1 key (the generator point G).
    bytes constant EPK = hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    bytes constant META = hex"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    StealthClaims internal sc;
    IERC6538Registry internal reg = IERC6538Registry(StealthCode.REGISTRY);

    function setUp() public override {
        super.setUp();
        vm.etch(StealthCode.ANNOUNCER, StealthCode.ANNOUNCER_RUNTIME);
        vm.etch(StealthCode.REGISTRY, StealthCode.REGISTRY_RUNTIME);
        sc = new StealthClaims(address(crowd), IERC5564Announcer(StealthCode.ANNOUNCER), reg);
        vm.prank(owner);
        crowd.setStealthClaims(sc);
    }

    function _quiet(address user) internal {
        SavingsVault.Settings memory s = vault.settingsOf(user);
        s.mode = 1;
        vm.startPrank(user);
        vault.setSettings(s);
        reg.registerKeys(1, META);
        vm.stopPrank();
    }

    /// Users 0..2 join A with 10/20/30 USDG; user 0 and 1 are Quiet; book 0 executed.
    function _executed() internal returns (address[] memory users) {
        users = new address[](3);
        for (uint256 i; i < 3; ++i) {
            users[i] = _user(i);
            _joinA(users[i], (i + 1) * 10 * U);
        }
        _quiet(users[0]);
        _quiet(users[1]);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS);
        vm.warp(_reveal(address(tokA), 0, SECRET));
        _freshFeeds();
        crowd.execute(address(tokA));
    }

    // ---------------------------------------------------------------- wiring

    function test_setStealthClaimsOnceOwnerOnlyMatchingCrowd() public {
        CrowdBuy c2 = new CrowdBuy(vault, router, crowd.beacon(), 3, SLIP, GENESIS, owner, keeper);
        StealthClaims wrong = new StealthClaims(address(crowd), IERC5564Announcer(StealthCode.ANNOUNCER), reg);
        vm.expectRevert();
        c2.setStealthClaims(wrong); // not owner
        vm.startPrank(owner);
        vm.expectRevert(CrowdBuy.BadParam.selector);
        c2.setStealthClaims(wrong); // points at another crowd
        StealthClaims right = new StealthClaims(address(c2), IERC5564Announcer(StealthCode.ANNOUNCER), reg);
        c2.setStealthClaims(right);
        vm.expectRevert(CrowdBuy.AlreadySet.selector);
        c2.setStealthClaims(right);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- deliver (names the user)

    function test_deliverRequiresQuietMode() public {
        address[] memory users = _executed();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.NotQuiet.selector, users[2]));
        crowd.deliver(address(tokA), 0, users[2], QUIET);
    }

    function test_deliverRequiresRegisteredMetaAddress() public {
        address[] memory users = _executed();
        address u = users[2];
        SavingsVault.Settings memory s = vault.settingsOf(u);
        s.mode = 1;
        vm.prank(u);
        vault.setSettings(s);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.NoMetaAddress.selector, u));
        crowd.deliver(address(tokA), 0, u, QUIET);
    }

    function test_deliverSettlesAllocationIntoPool() public {
        address[] memory users = _executed();
        uint256 alloc = crowd.allocationOf(address(tokA), 0, users[0]);
        assertGt(alloc, 0);
        vm.expectEmit(address(crowd));
        emit CrowdBuy.Delivered(address(tokA), 0, users[0], alloc);
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        assertEq(sc.pooled(address(tokA)), alloc);
        assertEq(tokA.balanceOf(address(sc)), alloc);
        assertTrue(crowd.settled(address(tokA), 0, users[0]));
        // the user can no longer also claim openly, and the keeper cannot deliver twice
        vm.prank(users[0]);
        vm.expectRevert(CrowdBuy.AlreadySettled.selector);
        crowd.claimOpen(address(tokA), 0);
        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.AlreadySettled.selector);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
    }

    function test_deliverBeforeExecutionReverts() public {
        address u = _user(0);
        _joinA(u, 10 * U);
        _quiet(u);
        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.NotExecuted.selector);
        crowd.deliver(address(tokA), 0, u, QUIET);
    }

    function test_quietUserCanStillClaimOpenBeforeDelivery() public {
        address[] memory users = _executed();
        uint256 alloc = crowd.allocationOf(address(tokA), 0, users[0]);
        vm.prank(users[0]);
        crowd.claimOpen(address(tokA), 0);
        assertEq(tokA.balanceOf(users[0]), alloc);
        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.AlreadySettled.selector);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
    }

    function test_dustSettlesWhenLastAccountIsDeliveredQuietly() public {
        address[] memory users = _executed();
        vm.prank(users[2]);
        crowd.claimOpen(address(tokA), 0);
        vm.startPrank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        crowd.deliver(address(tokA), 0, users[1], QUIET);
        vm.stopPrank();
        CrowdBuy.Book memory b = crowd.book(address(tokA), 0);
        assertEq(crowd.settlement(address(tokA), 0).settledRaw + crowd.dust(address(tokA)), b.rawOut);
    }

    // ---------------------------------------------------------------- deliverStealth (names only the stealth)

    function test_deliverStealthCreditsAndAnnounces() public {
        address[] memory users = _executed();
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        uint256 alloc = sc.pooled(address(tokA));
        address stealth = makeAddr("stealth");
        uint256 part = alloc / 3;
        vm.recordLogs();
        vm.prank(keeper);
        crowd.deliverStealth(address(tokA), stealth, part, EPK, bytes1(0x56));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != StealthCode.ANNOUNCER) continue;
            found = true;
            assertEq(logs[i].topics[0], IERC5564Announcer.Announcement.selector);
            assertEq(uint256(logs[i].topics[1]), 1);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), stealth);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), address(crowd));
            (bytes memory epk, bytes memory meta) = abi.decode(logs[i].data, (bytes, bytes));
            assertEq(epk, EPK);
            assertEq(meta, abi.encodePacked(bytes1(0x56), IERC20.transfer.selector, address(tokA), part));
            assertEq(meta.length, 57);
        }
        assertTrue(found, "announcement emitted");
        assertEq(sc.balanceOf(address(tokA), stealth), part);
        assertEq(sc.pooled(address(tokA)), alloc - part);
    }

    function test_deliverStealthNamesNoUser() public {
        address[] memory users = _executed();
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        uint256 alloc = sc.pooled(address(tokA));
        vm.recordLogs();
        vm.prank(keeper);
        crowd.deliverStealth(address(tokA), makeAddr("stealth"), alloc, EPK, bytes1(0x01));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 userWord = bytes32(uint256(uint160(users[0])));
        for (uint256 i; i < logs.length; ++i) {
            for (uint256 t; t < logs[i].topics.length; ++t) assertTrue(logs[i].topics[t] != userWord);
            assertEq(_contains(logs[i].data, abi.encodePacked(users[0])), false);
        }
    }

    function test_deliverStealthBoundsAndAuth() public {
        address[] memory users = _executed();
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        uint256 alloc = sc.pooled(address(tokA));
        address stealth = makeAddr("stealth");
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.deliverStealth(address(tokA), stealth, 1, EPK, bytes1(0));
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.PoolTooSmall.selector, alloc, alloc + 1));
        crowd.deliverStealth(address(tokA), stealth, alloc + 1, EPK, bytes1(0));
        vm.expectRevert(CrowdBuy.BadEphemeralKey.selector);
        crowd.deliverStealth(address(tokA), stealth, 1, hex"04aa", bytes1(0));
        bytes memory badPrefix = EPK;
        badPrefix[0] = 0x04;
        vm.expectRevert(CrowdBuy.BadEphemeralKey.selector);
        crowd.deliverStealth(address(tokA), stealth, 1, badPrefix, bytes1(0));
        // pool of another asset is empty
        vm.expectRevert(abi.encodeWithSelector(StealthClaims.PoolTooSmall.selector, 0, 1));
        crowd.deliverStealth(address(tokB), stealth, 1, EPK, bytes1(0));
        vm.stopPrank();
    }

    /// Full path: Quiet users delivered, allocations split into two stealth parts each, every part claimed by
    /// its stealth key through a relayer to a fresh address. The users' main wallets never touch the stealths.
    function test_quietEndToEndSplitAndRelayedClaims() public {
        address[] memory users = _executed();
        uint256[2] memory alloc =
            [crowd.allocationOf(address(tokA), 0, users[0]), crowd.allocationOf(address(tokA), 0, users[1])];
        vm.startPrank(keeper);
        crowd.deliver(address(tokA), 0, users[0], QUIET);
        crowd.deliver(address(tokA), 0, users[1], QUIET);
        vm.stopPrank();

        for (uint256 u; u < 2; ++u) {
            uint256 first = alloc[u] * 37 / 100;
            _partAndClaim(users[u], u, 0, first);
            _partAndClaim(users[u], u, 1, alloc[u] - first);
        }
        assertEq(sc.pooled(address(tokA)), 0);
        assertEq(tokA.balanceOf(address(sc)), 0);
    }

    function _partAndClaim(address user, uint256 u, uint256 p, uint256 raw) internal {
        uint256 key = uint256(keccak256(abi.encode("stealth", u, p))); // test-key
        address stealth = vm.addr(key);
        vm.prank(keeper);
        crowd.deliverStealth(address(tokA), stealth, raw, EPK, bytes1(uint8(p)));
        address fresh = makeAddr(string(abi.encode("fresh", u, p)));
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, sc.claimDigest(address(tokA), stealth, fresh, raw, 0, dl));
        vm.prank(makeAddr("relayer"));
        sc.claim(address(tokA), stealth, fresh, raw, dl, abi.encodePacked(r, s, v));
        assertEq(tokA.balanceOf(fresh), raw);
        assertEq(tokA.balanceOf(user), 0, "main wallet untouched");
        assertEq(stealth.balance, 0, "stealth never funded with gas");
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
