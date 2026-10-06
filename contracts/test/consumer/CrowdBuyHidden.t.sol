// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy, IShieldedDeposit} from "../../src/consumer/CrowdBuy.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {CrowdBuyBase} from "./CrowdBuyBase.sol";
import {SwitchVerifier} from "./ShieldedPoolBase.sol";

/// Hidden delivery: CrowdBuy.deliver(route = Hidden) -> ShieldedPool.depositFor with the user's registered ownerPk.
contract CrowdBuyHiddenTest is CrowdBuyBase {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 constant SECRET = keccak256("h");
    bytes32 constant OWNER_PK = bytes32(uint256(0x1234));
    bytes32 constant VIEW_PUB = bytes32(uint256(0x5678));
    bytes32 constant BLINDING = bytes32(uint256(0xb1));

    ShieldedPool internal pool;

    function setUp() public override {
        super.setUp();
        pool = new ShieldedPool(new SwitchVerifier(), new SwitchVerifier(), owner);
        vm.startPrank(owner);
        pool.setCrowd(address(crowd));
        crowd.setShieldedPool(IShieldedDeposit(address(pool)));
        pool.proposeCap(address(tokA), 1e30);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.applyCap(address(tokA));
        vm.warp(T0);
    }

    function _route(bytes memory note) internal pure returns (bytes memory) {
        return abi.encode(uint8(2), BLINDING, note);
    }

    function _hidden(address user, bool keys) internal {
        SavingsVault.Settings memory s = vault.settingsOf(user);
        s.mode = 2;
        vm.startPrank(user);
        vault.setSettings(s);
        if (keys) vault.setHiddenKeys(OWNER_PK, VIEW_PUB);
        vm.stopPrank();
    }

    /// Users 0..2 join A; user 0 is Hidden with keys, user 1 Hidden without keys, user 2 Open; book 0 executed.
    function _executed() internal returns (address[] memory users) {
        users = new address[](3);
        for (uint256 i; i < 3; ++i) {
            users[i] = _user(i);
            _joinA(users[i], (i + 1) * 10 * U);
        }
        _hidden(users[0], true);
        _hidden(users[1], false);
        _commit(address(tokA), 0, SECRET);
        vm.warp(GENESIS);
        vm.warp(_reveal(address(tokA), 0, SECRET));
        _freshFeeds();
        _executeAsKeeper(address(tokA));
    }

    // ---------------------------------------------------------------- vault: hidden keys

    function test_setHiddenKeysValidatesAndEmits() public {
        address u = _user(9);
        vm.expectEmit(address(vault));
        emit SavingsVault.HiddenKeysSet(u, OWNER_PK, VIEW_PUB);
        vm.prank(u);
        vault.setHiddenKeys(OWNER_PK, VIEW_PUB);
        SavingsVault.HiddenKeys memory k = vault.hiddenKeysOf(u);
        assertEq(k.ownerPk, OWNER_PK);
        assertEq(k.viewingPub, VIEW_PUB);
        assertEq(vault.hiddenKeysOf(_user(8)).ownerPk, bytes32(0)); // only the caller's own entry

        vm.startPrank(u);
        vm.expectRevert(SavingsVault.InvalidSettings.selector);
        vault.setHiddenKeys(bytes32(P), VIEW_PUB); // not a field element
        vm.expectRevert(SavingsVault.InvalidSettings.selector);
        vault.setHiddenKeys(bytes32(0), VIEW_PUB);
        vm.expectRevert(SavingsVault.InvalidSettings.selector);
        vault.setHiddenKeys(OWNER_PK, bytes32(0));
        vault.setHiddenKeys(bytes32(0), bytes32(0)); // clear
        vm.stopPrank();
        assertEq(vault.hiddenKeysOf(u).ownerPk, bytes32(0));
    }

    // ---------------------------------------------------------------- wiring

    function test_setShieldedPoolOnceOwnerOnlyMatchingCrowd() public {
        CrowdBuy c2 = new CrowdBuy(vault, router, crowd.beacon(), 3, SLIP, GENESIS, owner, keeper);
        ShieldedPool wrong = new ShieldedPool(new SwitchVerifier(), new SwitchVerifier(), owner);
        vm.prank(owner);
        wrong.setCrowd(address(crowd));
        vm.expectRevert();
        c2.setShieldedPool(IShieldedDeposit(address(wrong))); // not owner
        vm.startPrank(owner);
        vm.expectRevert(CrowdBuy.BadParam.selector);
        c2.setShieldedPool(IShieldedDeposit(address(wrong))); // its crowd is another CrowdBuy
        ShieldedPool right = new ShieldedPool(new SwitchVerifier(), new SwitchVerifier(), owner);
        right.setCrowd(address(c2));
        c2.setShieldedPool(IShieldedDeposit(address(right)));
        vm.expectRevert(CrowdBuy.AlreadySet.selector);
        c2.setShieldedPool(IShieldedDeposit(address(right)));
        vm.stopPrank();
    }

    function test_hiddenRouteNeedsPoolConfigured() public {
        CrowdBuy c2 = new CrowdBuy(vault, router, crowd.beacon(), 3, SLIP, GENESIS, owner, keeper);
        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.HiddenNotConfigured.selector);
        c2.deliver(address(tokA), 0, _user(0), _route(""));
    }

    // ---------------------------------------------------------------- deliver Hidden

    function test_deliverHiddenQueuesNoteWithVaultOwnerKey() public {
        address[] memory users = _executed();
        uint256 alloc = crowd.allocationOf(address(tokA), 0, users[0]);
        assertGt(alloc, 0);
        bytes memory note = hex"0102";
        bytes32 c = pool.commitmentOf(address(tokA), alloc, OWNER_PK, BLINDING);
        vm.expectEmit(address(pool));
        emit ShieldedPool.DepositQueued(0, address(tokA), users[0], alloc, c);
        vm.expectEmit(address(pool));
        emit ShieldedPool.NoteEncrypted(c, note);
        vm.expectEmit(address(crowd));
        emit CrowdBuy.Delivered(address(tokA), 0, users[0], alloc);
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], _route(note));
        assertEq(tokA.balanceOf(address(pool)), alloc);
        assertEq(pool.shielded(address(tokA)), alloc);
        assertTrue(crowd.settled(address(tokA), 0, users[0]));
        ShieldedPool.Pending memory p = pool.pending(0);
        assertEq(p.origin, users[0]);
        assertEq(p.commitment, c);
        assertEq(tokA.allowance(address(crowd), address(pool)), 0);

        vm.prank(keeper);
        vm.expectRevert(CrowdBuy.AlreadySettled.selector);
        crowd.deliver(address(tokA), 0, users[0], _route(note));
    }

    /// "a pending deposit can return to its origin": the user (not CrowdBuy, not the keeper) can take it back.
    function test_userCanRefundHiddenDeliveryWhilePending() public {
        address[] memory users = _executed();
        uint256 alloc = crowd.allocationOf(address(tokA), 0, users[0]);
        vm.prank(keeper);
        crowd.deliver(address(tokA), 0, users[0], _route(""));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotOrigin.selector, 0));
        pool.refundPending(0);
        vm.prank(users[0]);
        pool.refundPending(0);
        assertEq(tokA.balanceOf(users[0]), alloc);
    }

    function test_deliverHiddenRequiresHiddenModeAndKeys() public {
        address[] memory users = _executed();
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.NoHiddenKeys.selector, users[1]));
        crowd.deliver(address(tokA), 0, users[1], _route(""));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.NotHidden.selector, users[2]));
        crowd.deliver(address(tokA), 0, users[2], _route(""));
        vm.stopPrank();
        // keys alone (Open mode) are not enough either
        vm.prank(users[2]);
        vault.setHiddenKeys(OWNER_PK, VIEW_PUB);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.NotHidden.selector, users[2]));
        crowd.deliver(address(tokA), 0, users[2], _route(""));
    }

    function test_deliverHiddenOnlyKeeper() public {
        address[] memory users = _executed();
        vm.prank(users[0]);
        vm.expectRevert(CrowdBuy.NotKeeper.selector);
        crowd.deliver(address(tokA), 0, users[0], _route(""));
    }

    function test_routeParsing() public {
        address[] memory users = _executed();
        vm.startPrank(keeper);
        bytes memory r = abi.encode(uint8(3));
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.UnknownRoute.selector, r));
        crowd.deliver(address(tokA), 0, users[0], r);
        r = abi.encode(uint8(1), BLINDING); // Quiet must be exactly one word
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.UnknownRoute.selector, r));
        crowd.deliver(address(tokA), 0, users[0], r);
        r = hex"02";
        vm.expectRevert(abi.encodeWithSelector(CrowdBuy.UnknownRoute.selector, r));
        crowd.deliver(address(tokA), 0, users[0], r);
        vm.expectRevert(); // Hidden word but not a valid (uint8, bytes32, bytes) encoding
        crowd.deliver(address(tokA), 0, users[0], abi.encode(uint8(2)));
        vm.stopPrank();
    }

    function test_hiddenUserCanStillClaimOpen() public {
        address[] memory users = _executed();
        uint256 alloc = crowd.allocationOf(address(tokA), 0, users[0]);
        vm.prank(users[0]);
        crowd.claimOpen(address(tokA), 0);
        assertEq(tokA.balanceOf(users[0]), alloc);
    }

    function test_hiddenDeliveryRespectsPoolCapAndPause() public {
        address[] memory users = _executed();
        vm.prank(owner);
        pool.setDepositsPaused(true);
        vm.prank(keeper);
        vm.expectRevert(ShieldedPool.Paused.selector);
        crowd.deliver(address(tokA), 0, users[0], _route(""));
        vm.startPrank(owner);
        pool.setDepositsPaused(false);
        pool.proposeCap(address(tokA), 1);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(); // CapExceeded: the user can still claimOpen
        crowd.deliver(address(tokA), 0, users[0], _route(""));
        assertFalse(crowd.settled(address(tokA), 0, users[0]));
    }
}
