// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PerpFixture} from "../perps/PerpFixture.sol";
import {PerpMarket} from "../../src/perps/PerpMarket.sol";
import {PerpPool} from "../../src/perps/PerpPool.sol";

/// Review v2 L-6, applied to the perps proposals (PerpPool / PerpMarket `etaOf`): a matured proposal expires
/// PROPOSAL_EXPIRY (14 days) after its eta, and an ownership change voids every proposal made before it (the
/// owner nonce is part of the id). Before the fix both lived forever and survived a hand-over.
contract PerpProposalExpiryTest is PerpFixture {
    address registrar = makeAddr("registrar");
    address newOwner = makeAddr("newOwner");
    PerpMarket fresh;

    function setUp() public override {
        super.setUp(); // the pool has LP shares: registrar and market changes are timelocked
        fresh = new PerpMarket(pool, valuer, address(token), owner);
    }

    function _handOverPool() internal {
        vm.prank(owner);
        pool.transferOwnership(newOwner);
        vm.prank(newOwner);
        pool.acceptOwnership();
    }

    function _handOverMarket() internal {
        vm.prank(owner);
        fresh.transferOwnership(newOwner);
        vm.prank(newOwner);
        fresh.acceptOwnership();
    }

    // ---------------------------------------------------------------- PerpPool

    function test_poolProposalAppliesInsideItsWindow() public {
        vm.prank(owner);
        pool.proposeMakerRegistrar(registrar);
        vm.warp(block.timestamp + pool.TIMELOCK() + pool.PROPOSAL_EXPIRY());
        vm.prank(owner);
        pool.setMakerRegistrar(registrar);
        assertEq(pool.makerRegistrar(), registrar);
    }

    function test_poolProposalExpires14DaysAfterItsEta() public {
        vm.prank(owner);
        pool.proposeMakerRegistrar(registrar);
        bytes32 id = pool.registrarId(registrar);
        uint256 eta = pool.etaOf(id);
        vm.warp(eta + pool.PROPOSAL_EXPIRY() + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.ProposalExpired.selector, id, eta));
        pool.setMakerRegistrar(registrar);
        // a fresh proposal gives a fresh notice
        vm.prank(owner);
        pool.proposeMakerRegistrar(registrar);
        vm.warp(block.timestamp + pool.TIMELOCK());
        vm.prank(owner);
        pool.setMakerRegistrar(registrar);
        assertEq(pool.makerRegistrar(), registrar);
    }

    function test_poolProposalDiesWithAnOwnershipChange() public {
        vm.prank(owner);
        pool.proposeMarket(address(fresh));
        uint256 n = pool.proposalNonce();
        _handOverPool();
        assertEq(pool.proposalNonce(), n + 1);
        vm.warp(block.timestamp + pool.TIMELOCK());
        bytes32 id = pool.marketId(address(fresh)); // the new owner's id: nothing was proposed under it
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(PerpPool.TimelockActive.selector, id, 0));
        pool.addMarket(address(fresh));
        // the new owner's own proposal works
        vm.prank(newOwner);
        pool.proposeMarket(address(fresh));
        vm.warp(block.timestamp + pool.TIMELOCK());
        vm.prank(newOwner);
        pool.addMarket(address(fresh));
        assertTrue(pool.isMarket(address(fresh)));
    }

    // ---------------------------------------------------------------- PerpMarket

    function _raiseBorrow(address who, bool propose) internal {
        vm.prank(who);
        if (propose) fresh.proposeParams(10, 6, 1_000, 2, 2.78e11, 2_000, 10_000, 5e6);
        else fresh.setParams(10, 6, 1_000, 2, 2.78e11, 2_000, 10_000, 5e6);
    }

    function test_marketProposalExpires14DaysAfterItsEta() public {
        _raiseBorrow(owner, true);
        PerpMarket.Params memory p = PerpMarket.Params(10, 6, 1_000, 2, 2.78e11, 2_000, 10_000, 5e6);
        bytes32 id = fresh.paramsId(p);
        uint256 eta = fresh.etaOf(id);
        assertGt(eta, 0);
        vm.warp(eta + fresh.PROPOSAL_EXPIRY() + 1);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.ProposalExpired.selector, id, eta));
        _raiseBorrow(owner, false);
    }

    function test_marketProposalAppliesInsideItsWindow() public {
        _raiseBorrow(owner, true);
        vm.warp(block.timestamp + pool.TIMELOCK() + 1 days);
        _raiseBorrow(owner, false);
        assertEq(fresh.borrowBpsPerHour(), 2);
    }

    function test_marketProposalDiesWithAnOwnershipChange() public {
        _raiseBorrow(owner, true);
        _handOverMarket();
        vm.warp(block.timestamp + pool.TIMELOCK());
        PerpMarket.Params memory p = PerpMarket.Params(10, 6, 1_000, 2, 2.78e11, 2_000, 10_000, 5e6);
        vm.expectRevert(abi.encodeWithSelector(PerpMarket.TimelockActive.selector, fresh.paramsId(p), 0));
        _raiseBorrow(newOwner, false);
        assertEq(fresh.borrowBpsPerHour(), 1);
    }
}
