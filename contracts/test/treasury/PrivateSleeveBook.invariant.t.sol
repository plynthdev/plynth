// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateSleeveFixture} from "./PrivateSleeve.t.sol";
import {PrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {Valuer} from "../../src/core/Valuer.sol";
import {SplitWithdrawFixture as F} from "../review3/SplitWithdrawFixture.sol";
import {BoardNoteFixture as B} from "../review4/BoardNoteFixture.sol";

/// Random board / stranger moves against an open private book: plain transfers of private and other assets into
/// the sleeve (including the board's own AAPL taken out with withdrawToBoard), forged and real sweeps, the real
/// pool withdraw, unshield, forwardOther, the controller's split proofs of one note, and a note the BOARD deposited
/// itself withdrawn to the sleeve (review4 R4-TREAS-1). Ghost: what the pool paid out of the sleeve's own notes.
contract SleeveBookHandler is Test {
    PrivateSleeve immutable sleeve;
    ShieldedPool immutable pool;
    TreasuryAccount immutable account;
    MockStockToken immutable aapl;
    MockStockToken immutable nvda;
    MockUSDG immutable usdg;
    address immutable board;
    Valuer immutable valuer;
    bytes proof;
    ShieldedPool.PublicWithdraw realPub;

    uint256 public provenDebit; // USD the sleeve debited from the book
    uint256 public paidUsd; // USD the pool paid the sleeve out of the SLEEVE'S OWN notes (foreign notes excluded)
    uint256 public calls;

    constructor(
        PrivateSleeve s,
        ShieldedPool p,
        TreasuryAccount a,
        MockStockToken aapl_,
        MockStockToken nvda_,
        MockUSDG usdg_,
        address board_,
        bytes memory proof_,
        ShieldedPool.PublicWithdraw memory pub_
    ) {
        (sleeve, pool, account, aapl, nvda, usdg, board) = (s, p, a, aapl_, nvda_, usdg_, board_);
        proof = proof_;
        valuer = s.valuer();
        realPub = pub_;
    }

    function boardRecycles(uint256 raw, bool useNvda) external {
        ++calls;
        MockStockToken t = useNvda ? nvda : aapl;
        uint256 bal = t.balanceOf(address(account));
        if (bal == 0) return;
        raw = bound(raw, 1, bal);
        vm.startPrank(board);
        account.withdrawToBoard(address(t), raw);
        t.transfer(address(sleeve), raw);
        vm.stopPrank();
    }

    function donate(uint256 raw, uint8 which) external {
        ++calls;
        raw = bound(raw, 1, 1e24);
        if (which % 3 == 0) aapl.mint(address(sleeve), raw);
        else if (which % 3 == 1) nvda.mint(address(sleeve), raw);
        else usdg.mint(address(sleeve), raw % 1e12 + 1);
    }

    /// Any sweep at all: a recorded nullifier or not, either asset, any amount. Only a sweep that matches what the
    /// pool paid the sleeve may succeed; whatever it debits is counted.
    function anySweep(uint8 which, bool useNvda, uint256 amount, bytes32 randomNf) external {
        ++calls;
        bytes32[6] memory nfs =
            [realPub.nullifier, bytes32(F.NF0), bytes32(F.NF1), bytes32(F.NF2), bytes32(B.NF), randomNf];
        bytes32 nf = nfs[which % 6];
        address asset = useNvda ? address(nvda) : address(aapl);
        if (amount % 4 == 0) amount = 1; // the split proofs' 1-wei withdraws
        else if (amount % 4 == 1) amount = [uint256(200e18), F.AMT0B, F.AMT2B, B.AMOUNT][(amount >> 8) % 4];
        else amount = bound(amount, 0, 1e24);
        uint256 b = sleeve.bookUsd();
        try sleeve.sweep(nf, asset, amount) {
            require(pool.withdrawnOf(nf) == keccak256(abi.encode(address(sleeve), asset, amount)), "unrecorded sweep");
            provenDebit += b - sleeve.bookUsd();
        } catch {}
    }

    /// The board's own note (deposited in setUp, leaf 3), withdrawn in full to the sleeve. Not a sleeve note.
    function boardNoteWithdraw() external {
        ++calls;
        ShieldedPool.PublicWithdraw memory w;
        w.root = bytes32(B.ROOT);
        w.nullifier = bytes32(B.NF);
        w.asset = address(aapl);
        w.amount = B.AMOUNT;
        w.recipient = address(sleeve);
        try pool.withdraw(B.PROOF, w) {} catch {}
    }

    /// Sweeps one of the withdraws the handler can make, with exactly the amount it paid.
    function sweepKnown(uint8 which) external {
        ++calls;
        which = which % 8;
        bytes32[8] memory nfs = [realPub.nullifier, bytes32(F.NF0), bytes32(F.NF0), bytes32(F.NF1), bytes32(F.NF1),
            bytes32(F.NF2), bytes32(F.NF2), bytes32(B.NF)];
        uint256[8] memory amts = [uint256(200e18), 1, F.AMT0B, 1, F.AMT1B, 1, F.AMT2B, B.AMOUNT];
        address asset = (which == 5 || which == 6) ? address(nvda) : address(aapl);
        uint256 b = sleeve.bookUsd();
        try sleeve.sweep(nfs[which], asset, amts[which]) {
            provenDebit += b - sleeve.bookUsd();
        } catch {}
    }

    function realWithdraw() external {
        ++calls;
        try pool.withdraw(proof, realPub) {
            _paid(realPub.asset, realPub.amount);
        } catch {}
    }

    /// The controller's split proofs (same nullifier per note): A pays 1 wei and keeps the change, B the whole note.
    function splitWithdraw(uint8 note, bool full) external {
        ++calls;
        note = note % 3;
        uint256 nf = [F.NF0, F.NF1, F.NF2][note];
        address asset = note == 2 ? address(nvda) : address(aapl);
        ShieldedPool.PublicWithdraw memory w;
        w.root = bytes32(F.ROOT);
        w.nullifier = bytes32(nf);
        w.asset = asset;
        w.recipient = address(sleeve);
        bytes memory pr;
        if (full) {
            w.amount = [F.AMT0B, F.AMT1B, F.AMT2B][note];
            pr = note == 0 ? F.PROOF0B : note == 1 ? F.PROOF1B : F.PROOF2B;
        } else {
            w.amount = 1;
            w.changeCommitment = bytes32([F.CC0A, F.CC1A, F.CC2A][note]);
            pr = note == 0 ? F.PROOF0A : note == 1 ? F.PROOF1A : F.PROOF2A;
        }
        try pool.withdraw(pr, w) {
            _paid(asset, w.amount);
        } catch {}
    }

    function _paid(address asset, uint256 raw) private {
        (uint256 usd,) = valuer.value(asset, raw);
        paidUsd += usd;
    }

    function unshield() external {
        ++calls;
        uint256 b = sleeve.bookUsd();
        try sleeve.unshield(proof, realPub) {
            _paid(realPub.asset, realPub.amount);
            provenDebit += b - sleeve.bookUsd();
        } catch {}
    }

    function forwardOther(bool tryPrivate) external {
        ++calls;
        try sleeve.forwardOther(tryPrivate ? address(aapl) : address(usdg)) {} catch {}
    }
}

/// V2-L8 / R3-TREAS-1 / R4-TREAS-1 invariant: the private book never drops by more than the pool paid out of the
/// sleeve's OWN notes (prices constant), so it never falls below the value of the sleeve's notes still shielded,
/// whatever mix of plain transfers, forged sweeps, split proofs of one note, the board's own note withdrawn to the
/// sleeve and real withdraws runs.
contract PrivateSleeveBookInvariantTest is PrivateSleeveFixture {
    SleeveBookHandler handler;
    uint256 book0;

    function setUp() public override {
        super.setUp();
        _shieldBook();
        _proveBook(); // the three shields are proven sleeve notes
        book0 = sleeve.bookUsd();
        // The board's own note goes in as leaf 3 (BoardNoteFixture's tree), before anything else is inserted.
        vm.startPrank(board);
        account.withdrawToBoard(address(aapl), B.AMOUNT);
        aapl.approve(address(pool), B.AMOUNT);
        pool.deposit(address(aapl), B.AMOUNT, bytes32(B.BOARD_PK), bytes32(B.BLINDING), bytes(""));
        vm.stopPrank();
        _warp(block.timestamp + 2 hours + 1);
        pool.insertPending(10);
        assertEq(pool.currentRoot(), bytes32(B.ROOT));
        handler = new SleeveBookHandler(
            sleeve, pool, account, aapl, nvda, usdg, board, _hex(".withdraw.proofHex"), _withdrawPub()
        );
        targetContract(address(handler));
    }

    /// Real Honk verifier calls are heavy: fewer, shorter runs.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 60
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_bookDropsOnlyByProvenProceeds() public view {
        assertEq(sleeve.bookUsd() + handler.provenDebit(), book0, "book moved other than by a sweep/unshield");
        assertLe(handler.provenDebit(), handler.paidUsd(), "book debited by more than the sleeve's own notes paid out");
    }
}
