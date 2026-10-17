// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {PrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {SplitWithdrawFixture as F} from "./SplitWithdrawFixture.sol";

/// review3 R3-TREAS-1 regression. The nullifier does not bind amount, recipient or change, so the controller can
/// prove one note twice: proof A withdraws 1 wei to the sleeve (the rest stays in the pool as change), proof B
/// claims the whole note. The old `sweep` re-verified B and debited the whole note against the board's recycled
/// tokens, zeroing the book while the notes stayed shielded. `sweep` now debits only what the pool recorded paying
/// the sleeve for that nullifier (1 wei here). Real UltraHonk proofs (gen-split-withdraw.ts), real ShieldedPool,
/// real WithdrawVerifier.
contract R3PrivateSleeveSplitSweepTest is PrivateSleeveFixture {
    function _pub(uint256 nf, address asset, uint256 amount, uint256 cc)
        internal
        view
        returns (ShieldedPool.PublicWithdraw memory w)
    {
        w.root = bytes32(F.ROOT);
        w.nullifier = bytes32(nf);
        w.changeCommitment = bytes32(cc);
        w.asset = asset;
        w.amount = amount;
        w.recipient = address(sleeve);
    }

    /// One attack round; returns the USD the (allowed) 1-wei sweep debited.
    function _round(uint256 nf, address asset, bytes memory pa, uint256 ccA, uint256 amtB) internal returns (uint256) {
        pool.withdraw(pa, _pub(nf, asset, 1, ccA)); // 1. controller: 1 wei to the sleeve, change stays shielded
        vm.startPrank(board); // 2. board: puts its own (recycled) tokens in the sleeve
        uint256 bal = asset == address(aapl) ? aapl.balanceOf(address(account)) : nvda.balanceOf(address(account));
        uint256 take = bal < amtB ? bal : amtB;
        account.withdrawToBoard(asset, take);
        vm.stopPrank();
        if (take < amtB) {
            if (asset == address(aapl)) aapl.mint(board, amtB - take);
            else nvda.mint(board, amtB - take);
        }
        vm.prank(board);
        (bool ok,) = asset.call(abi.encodeWithSignature("transfer(address,uint256)", address(sleeve), amtB));
        require(ok);
        // 3. a full-note sweep is refused: the pool paid 1 wei, not amtB
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.NotWithdrawnHere.selector, bytes32(nf)));
        sleeve.sweep(bytes32(nf), asset, amtB);
        // the real proceeds (1 wei) can be swept, once
        uint256 b = sleeve.bookUsd();
        sleeve.sweep(bytes32(nf), asset, 1);
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.AlreadyForwarded.selector, bytes32(nf)));
        sleeve.sweep(bytes32(nf), asset, 1);
        return b - sleeve.bookUsd();
    }

    function _allRounds() internal returns (uint256 debited) {
        debited += _round(F.NF0, address(aapl), F.PROOF0A, F.CC0A, F.AMT0B);
        debited += _round(F.NF1, address(aapl), F.PROOF1A, F.CC1A, F.AMT1B);
        debited += _round(F.NF2, address(nvda), F.PROOF2A, F.CC2A, F.AMT2B);
    }

    function test_r3_splitProofSweepCannotZeroTheBook() public {
        _shieldBook();
        uint256 book = sleeve.bookUsd();
        _warp(block.timestamp + PERIOD + 4 days + 1);
        assertTrue(sleeve.bookStale(), "stale: shields refused until a fresh proof");

        uint256 debited = _allRounds();
        assertEq(sleeve.bookUsd(), book - debited, "debited only by what the pool paid");
        assertLt(debited, 1e6, "three 1-wei withdraws: a few wei of USD");
        assertTrue(sleeve.bookStale(), "L-6 stale refusal still holds");

        vm.prank(board);
        vm.expectRevert(TreasuryAccount.PrivateBookOpen.selector);
        account.setPrivateSleeve(address(0), bytes32(0));
        assertEq(account.privateSleeve(), address(sleeve));
    }

    function test_r3_splitProofSweepCannotResetStaleness() public {
        _shieldBook();
        _warp(block.timestamp + PERIOD + 4 days + 1);
        _allRounds();
        aapl.mint(address(account), 10e18);
        vm.expectRevert(abi.encodeWithSelector(TreasuryAccount.GuardRejected.selector, uint8(18)));
        vm.prank(privKey);
        account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), 10e18, bytes32(uint256(0x77))), new bytes32[](0), 0);
    }

    /// The honest full withdraw still debits the whole note.
    function test_r3_fullWithdrawStillDebitsTheNote() public {
        _shieldBook();
        uint256 book = sleeve.bookUsd();
        pool.withdraw(F.PROOF0B, _pub(F.NF0, address(aapl), F.AMT0B, 0));
        sleeve.sweep(bytes32(F.NF0), address(aapl), F.AMT0B);
        assertEq(sleeve.bookUsd(), book - 50_000e18, "250 AAPL at $200");
    }
}
