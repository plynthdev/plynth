// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateSleeveFixture} from "./PrivateSleeve.t.sol";
import {PrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";

/// Random board / stranger moves against an open private book: plain transfers of private and other assets into
/// the sleeve (including the board's own AAPL taken out with withdrawToBoard), forged and real sweeps, the real
/// pool withdraw, unshield, forwardOther. Ghost: the value of proven withdraw proceeds the sleeve forwarded.
contract SleeveBookHandler is Test {
    PrivateSleeve immutable sleeve;
    ShieldedPool immutable pool;
    TreasuryAccount immutable account;
    MockStockToken immutable aapl;
    MockStockToken immutable nvda;
    MockUSDG immutable usdg;
    address immutable board;
    bytes proof;
    ShieldedPool.PublicWithdraw realPub;

    uint256 public provenDebit; // USD of proceeds forwarded through a verified, spent withdraw
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

    function forgedSweep(bytes32 nullifier, uint256 amount, bool useReal) external {
        ++calls;
        ShieldedPool.PublicWithdraw memory w = realPub;
        if (!useReal) w.nullifier = nullifier;
        w.amount = useReal ? realPub.amount + bound(amount, 1, 1e24) : bound(amount, 0, 1e24);
        try sleeve.sweep(proof, w) {
            revert("forged sweep accepted");
        } catch {}
    }

    function realWithdraw() external {
        ++calls;
        try pool.withdraw(proof, realPub) {} catch {}
    }

    function realSweep() external {
        ++calls;
        uint256 b = sleeve.bookUsd();
        try sleeve.sweep(proof, realPub) {
            provenDebit += b - sleeve.bookUsd();
        } catch {}
    }

    function unshield() external {
        ++calls;
        uint256 b = sleeve.bookUsd();
        try sleeve.unshield(proof, realPub) {
            provenDebit += b - sleeve.bookUsd();
        } catch {}
    }

    function forwardOther(bool tryPrivate) external {
        ++calls;
        try sleeve.forwardOther(tryPrivate ? address(aapl) : address(usdg)) {} catch {}
    }
}

/// V2-L8 invariant: the private book never drops except by the value of proven pool-withdraw proceeds, so it can
/// never be zeroed while notes are still in the pool. The only provable note in the fixture is the 200 AAPL
/// ($40k) withdraw, forwarded at most once.
contract PrivateSleeveBookInvariantTest is PrivateSleeveFixture {
    SleeveBookHandler handler;
    uint256 book0;

    function setUp() public override {
        super.setUp();
        _shieldBook();
        book0 = sleeve.bookUsd();
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
        assertEq(sleeve.bookUsd() + handler.provenDebit(), book0, "book moved without proven proceeds");
        assertLe(handler.provenDebit(), 40_000e18, "more than the one provable note was debited");
        assertGt(sleeve.bookUsd(), 0, "book zeroed while notes are in the pool");
    }
}
