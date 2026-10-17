// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TreasuryFactoryTest} from "../treasury/TreasuryFactory.t.sol";
import {BoardSleeve} from "../review3/R3InsuranceCapNav.t.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {TreasuryFactory} from "../../src/treasury/TreasuryFactory.sol";
import {PerpSleeve} from "../../src/treasury/sleeves/PerpSleeve.sol";
import {IPerpVenue} from "../../src/interfaces/IPerpVenue.sol";
import {AdapterGate} from "../../src/libs/AdapterGate.sol";
import {ChangeDelay} from "../../src/libs/ChangeDelay.sol";
import {MockCashSleeve} from "../mocks/TreasuryMocks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Only `sleeve()` matters to `addVenue`; the gate runs before anything else is read.
contract StubVenue {
    address public sleeve;

    constructor(address s) {
        sleeve = s;
    }
}

/// The accepted-risk note "the guard trusts board-registered adapters" turned into code: on a factory treasury
/// `registerDesk` and `addVenue` take only adapters whose runtime codehash is on the factory's allow-list (OWNER,
/// ChangeDelay after the hand-over), and after the account's setup window only after the policy TIMELOCK.
contract AdapterAllowListTest is TreasuryFactoryTest {
    bytes32 constant D = "extra";

    function _afterSetup() internal {
        _deploy(board);
        _warp(fAccount.setupEndsAt() + 1);
    }

    /// A second cash sleeve with the fixture's code and immutables: the same codehash, so allow-listed.
    function _reviewed() internal returns (address) {
        return address(new MockCashSleeve(valuer, usdg, vault));
    }

    function test_instantRegistrationAfterSetupIsRefused() public {
        _afterSetup();
        address a = _reviewed();
        bytes32 id = fAccount.deskProposalId(D, cashKey, _one(a));
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.DeskNotProposed.selector, id));
        fAccount.registerDesk(D, cashKey, _one(a));
    }

    function test_timelockedRegistrationOfAllowListedAdapterWorks() public {
        _afterSetup();
        address a = _reviewed();
        vm.prank(board);
        fAccount.proposeDesk(D, cashKey, _one(a));
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.TimelockActive.selector, eta));
        fAccount.registerDesk(D, cashKey, _one(a));
        _warp(eta);
        vm.prank(board);
        fAccount.registerDesk(D, cashKey, _one(a));
        assertTrue(fAccount.isSleeve(a));
        // the proposal is used up, and a stale one expires
        assertEq(fAccount.deskEta(fAccount.deskProposalId(D, cashKey, _one(a))), 0);
    }

    function test_unknownCodehashRefusedEvenAfterTheTimelock() public {
        _afterSetup();
        BoardSleeve fake = new BoardSleeve(1e30);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.AdapterNotAllowed.selector, address(fake)));
        fAccount.proposeDesk(D, board, _one(address(fake)));
        // Proposed while (wrongly) listed, de-listed during the timelock: refused when applied.
        factory.setAdapterAllowed(address(fake).codehash, true);
        vm.prank(board);
        fAccount.proposeDesk(D, board, _one(address(fake)));
        factory.setAdapterAllowed(address(fake).codehash, false); // removal is instant
        _warp(block.timestamp + 48 hours);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.AdapterNotAllowed.selector, address(fake)));
        fAccount.registerDesk(D, board, _one(address(fake)));
    }

    function test_unknownCodehashRefusedEvenInTheSetupWindow() public {
        _deploy(board);
        BoardSleeve fake = new BoardSleeve(1e30);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.AdapterNotAllowed.selector, address(fake)));
        fAccount.registerDesk(D, board, _one(address(fake)));
    }

    /// After the hand-over every allow-list ADDITION waits CHANGE_DELAY in public; removals apply at once.
    function test_allowListAdditionsAreDelayedAfterTheHandOver() public {
        address o = makeAddr("owner");
        factory.transferOwnership(o);
        vm.prank(o);
        factory.acceptOwnership();
        bytes32 h = keccak256("some code");
        vm.prank(o);
        factory.setAdapterAllowed(h, true); // queued
        assertFalse(factory.adapterAllowed(h));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(o);
        factory.setAdapterAllowed(h, true); // applied
        assertTrue(factory.adapterAllowed(h));
        vm.prank(o);
        factory.setAdapterAllowed(h, false);
        assertFalse(factory.adapterAllowed(h));
        vm.prank(board);
        vm.expectRevert(TreasuryFactory.NotOwner.selector);
        factory.setAdapterAllowed(h, true);
    }

    /// The same gate on a perp sleeve's venues.
    function test_venueGate() public {
        _deploy(board);
        PerpSleeve perp = new PerpSleeve(address(fAccount), IERC20(address(usdg)), 0);
        StubVenue unknown = new StubVenue(address(perp));
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(AdapterGate.AdapterNotAllowed.selector, address(unknown)));
        perp.addVenue(IPerpVenue(address(unknown)));

        StubVenue reviewed = new StubVenue(address(perp));
        factory.setAdapterAllowed(address(reviewed).codehash, true); // the StubVenue code, as if reviewed
        _warp(fAccount.setupEndsAt() + 1);
        vm.prank(board);
        vm.expectRevert(abi.encodeWithSelector(AdapterGate.AdapterNotProposed.selector, address(reviewed)));
        perp.addVenue(IPerpVenue(address(reviewed)));
        vm.prank(board);
        perp.proposeVenue(IPerpVenue(address(reviewed)));
        _warp(block.timestamp + 48 hours);
        vm.prank(board);
        perp.addVenue(IPerpVenue(address(reviewed)));
        assertTrue(perp.isVenue(address(reviewed)));
    }

    /// The general property: a desk with a new adapter registers iff its codehash is allowed and (it is the setup
    /// window, or a matching proposal has waited the TIMELOCK and not expired).
    function testFuzz_registrationIffAllowedAndTimely(bool listed, bool propose, uint32 wait, uint32 start) public {
        _deploy(board);
        _warp(block.timestamp + (start % 6 days));
        address a = listed ? _reviewed() : address(new BoardSleeve(1));
        bool proposed;
        if (propose) {
            vm.prank(board);
            try fAccount.proposeDesk(D, cashKey, _one(a)) {
                proposed = true;
            } catch {}
        }
        uint256 proposedAt = block.timestamp;
        _warp(block.timestamp + (wait % 20 days));
        bool inSetup = block.timestamp <= fAccount.setupEndsAt();
        bool timely = proposed && block.timestamp >= proposedAt + 48 hours
            && block.timestamp <= proposedAt + 48 hours + fAccount.DESK_PROPOSAL_EXPIRY();
        vm.prank(board);
        bool ok;
        try fAccount.registerDesk(D, cashKey, _one(a)) {
            ok = true;
        } catch {}
        assertEq(ok, listed && (inSetup || timely));
    }
}
