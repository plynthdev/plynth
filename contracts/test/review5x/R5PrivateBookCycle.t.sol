// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateSleeveFixture} from "../treasury/PrivateSleeve.t.sol";
import {PrivateSleeve, IPrivateSleeve} from "../../src/treasury/PrivateSleeve.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {PeriodClose} from "../../src/treasury/PeriodClose.sol";
import {TreasuryAccount} from "../../src/treasury/TreasuryAccount.sol";
import {PolicyGuard} from "../../src/treasury/PolicyGuard.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";

/// Stands in for the WithdrawVerifier and the TreasuryCloseVerifier (etched over them): these tests are about
/// PrivateSleeve's accounting; the key holder (the controller) can make such proofs for real.
contract AcceptAllR5 {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}

uint256 constant FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

/// review5 R5-TREAS-3 regression. shield -> withdraw the unproven note to the sleeve -> sweep returned the tokens to
/// the account undebited, and the cycle repeated: 10 cycles took guard NAV from $1.05M to $1.45M with no change in
/// real holdings. Unproven proceeds are now held while anything was shielded since the last proof, and released
/// (undebited) after the next proof, so guard NAV never exceeds what the treasury holds.
contract R5PrivateBookCycleTest is PrivateSleeveFixture {
    function _etch() internal {
        vm.etch(address(pool.withdrawVerifier()), address(new AcceptAllR5()).code);
        vm.etch(address(closeVerifier), address(new AcceptAllR5()).code);
    }

    function _withdrawToSleeve(bytes32 nf, uint256 raw) internal {
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = nf;
        w.asset = address(aapl);
        w.amount = raw;
        w.recipient = address(sleeve);
        pool.withdraw("", w);
    }

    function _nf(uint256 i) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("r5nf", i))) % FIELD_P);
    }

    /// A refresh whose proof (accept-all here) proves `navUsd` of unspent notes at the current root.
    function _refresh(uint256 navUsd) internal {
        IPrivateSleeve.PrivateClose memory p;
        p.root = pool.currentRoot();
        p.navUsd = navUsd;
        pc.refreshPrivateBook(p);
    }

    function test_r5_shieldWithdrawSweepCycleCannotInflateTheBook() public {
        _etch();
        uint256 guardNav0 = guard.snapshot(address(account)).nav;
        uint256 aapl0 = aapl.balanceOf(address(account));
        for (uint256 i; i < 10; ++i) {
            _shield(address(aapl), 200e18, bytes32(uint256(1000 + i)));
            _warp(block.timestamp + 2 hours + 1);
            pool.insertPending(10);
            _withdrawToSleeve(_nf(i), 200e18);
            sleeve.sweep(_nf(i), address(aapl), 200e18); // held, not forwarded
            _warp(block.timestamp + 8 hours);
        }
        assertEq(guard.snapshot(address(account)).nav, guardNav0, "guard NAV unchanged: no double count");
        assertEq(aapl.balanceOf(address(sleeve)), 2_000e18, "the proceeds are held in the sleeve");
        vm.expectRevert(abi.encodeWithSelector(PrivateSleeve.HeldUntilProof.selector, _nf(0)));
        sleeve.release(_nf(0));

        _refresh(0); // the next proof: nothing is left shielded
        assertEq(sleeve.bookUsd(), 0);
        for (uint256 i; i < 10; ++i) {
            sleeve.release(_nf(i));
        }
        assertEq(aapl.balanceOf(address(account)), aapl0, "every token back in the account");
        assertEq(guard.snapshot(address(account)).nav, guardNav0, "and guard NAV is the real holdings again");
    }

    /// With nothing shielded since the last proof, an unproven nullifier cannot be in the book: forwarded at once.
    function test_r5_noShieldSinceProofForwardsAtOnce() public {
        _etch();
        _shield(address(aapl), 200e18, bytes32(uint256(7)));
        _warp(block.timestamp + 2 hours + 1);
        pool.insertPending(10);
        _refresh(40_000e18); // proven: the note is in the book, but its nullifier is not one the proof named
        assertEq(sleeve.shieldedSinceProofUsd(), 0);
        uint256 a0 = aapl.balanceOf(address(account));
        _withdrawToSleeve(_nf(99), 200e18);
        sleeve.sweep(_nf(99), address(aapl), 200e18);
        assertEq(aapl.balanceOf(address(account)) - a0, 200e18, "forwarded undebited");
    }
}

/// Random shields, own-note withdraws to the sleeve, foreign notes withdrawn to the sleeve, sweeps, releases and
/// honest refreshes (proving exactly the sleeve's unspent notes). Ghosts: the value of the sleeve's own notes still
/// in the pool, and of own-note proceeds held in the sleeve.
contract BookCycleHandler is Test {
    R5PrivateBookCycleInvariantTest immutable t;
    PrivateSleeve immutable sleeve;
    ShieldedPool immutable pool;
    MockStockToken immutable aapl;
    address immutable board;

    uint256 public ownUnspentUsd;
    uint256 public ownHeldUsd;
    uint256 n;
    bytes32[] ownPending; // own notes inserted, not yet withdrawn
    mapping(bytes32 => bool) isOwn;
    bytes32[] heldList;

    constructor(R5PrivateBookCycleInvariantTest t_, PrivateSleeve s, ShieldedPool p, MockStockToken a, address b, uint256 own0) {
        (t, sleeve, pool, aapl, board) = (t_, s, p, a, b);
        ownUnspentUsd = own0;
    }

    function shield(uint256 raw) external {
        raw = bound(raw, 1e18, 200e18);
        if (aapl.balanceOf(sleeve.account()) < raw) return;
        if (!t.shieldVia(raw, ++n)) return;
        t.warpBy(2 hours + 1);
        pool.insertPending(10);
        bytes32 nf = bytes32(uint256(keccak256(abi.encode("own", n))) % FIELD_P);
        ownPending.push(nf);
        isOwn[nf] = true;
        (uint256 usd,) = sleeve.valuer().value(address(aapl), raw);
        ownUnspentUsd += usd;
        usdOf[nf] = usd;
        rawOf[nf] = raw; // the withdraw takes the whole note
        t.warpBy(8 hours);
    }

    mapping(bytes32 => uint256) rawOf;
    mapping(bytes32 => uint256) usdOf;

    function withdrawOwn(uint256 i) external {
        if (ownPending.length == 0) return;
        i = i % ownPending.length;
        bytes32 nf = ownPending[i];
        ownPending[i] = ownPending[ownPending.length - 1];
        ownPending.pop();
        _withdraw(nf, rawOf[nf]);
        ownUnspentUsd -= usdOf[nf];
        _sweep(nf, rawOf[nf], true);
    }

    function foreign(uint256 raw) external {
        raw = bound(raw, 1e18, 100e18);
        t.mintAapl(board, raw);
        vm.startPrank(board);
        aapl.approve(address(pool), raw);
        pool.deposit(address(aapl), raw, bytes32(uint256(5)), bytes32(++n), "");
        vm.stopPrank();
        t.warpBy(2 hours + 1);
        pool.insertPending(10);
        bytes32 nf = bytes32(uint256(keccak256(abi.encode("foreign", n))) % FIELD_P);
        _withdraw(nf, raw);
        _sweep(nf, raw, false);
    }

    /// An honest proof: it opens up to 8 of the sleeve's unspent notes, names their nullifiers and proves their sum
    /// (the circuit cannot count a note without publishing its nullifier; a note left out is simply not counted).
    function refresh(uint8 count) external {
        uint256 k = ownPending.length < 8 ? ownPending.length : 8;
        k = k == 0 ? 0 : uint256(count) % (k + 1);
        bytes32[8] memory nfs;
        uint256 sum;
        for (uint256 i; i < k; ++i) {
            nfs[i] = ownPending[i];
            sum += usdOf[ownPending[i]];
        }
        t.refreshWith(sum, nfs);
    }

    function release(uint256 i) external {
        if (heldList.length == 0) return;
        i = i % heldList.length;
        bytes32 nf = heldList[i];
        try sleeve.release(nf) {
            if (isOwn[nf]) ownHeldUsd -= usdOf[nf];
            heldList[i] = heldList[heldList.length - 1];
            heldList.pop();
        } catch {}
    }

    function _withdraw(bytes32 nf, uint256 raw) internal {
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = nf;
        w.asset = address(aapl);
        w.amount = raw;
        w.recipient = address(sleeve);
        pool.withdraw("", w);
    }

    function _sweep(bytes32 nf, uint256 raw, bool own) internal {
        if (!own) rawOf[nf] = raw;
        sleeve.sweep(nf, address(aapl), raw);
        (,, uint256 held) = sleeve.heldProceeds(nf);
        if (held != 0) {
            heldList.push(nf);
            if (own) ownHeldUsd += usdOf[nf];
        }
    }
}

/// R5-TREAS-3 invariant (constant prices): the private book never exceeds the value of the sleeve's own notes still
/// in the pool plus own-note proceeds held in the sleeve, so guard NAV never exceeds the treasury's real holdings,
/// over any number of shield / withdraw / sweep / release / refresh cycles.
contract R5PrivateBookCycleInvariantTest is PrivateSleeveFixture {
    BookCycleHandler handler;

    function setUp() public override {
        super.setUp();
        vm.etch(address(pool.withdrawVerifier()), address(new AcceptAllR5()).code);
        vm.etch(address(closeVerifier), address(new AcceptAllR5()).code);
        handler = new BookCycleHandler(this, sleeve, pool, aapl, board, 0);
        aaplFeed.transferOwnership(address(this));
        targetContract(address(handler));
    }

    function shieldVia(uint256 raw, uint256 salt) external returns (bool) {
        vm.prank(privKey);
        try account.execute(PRIVATE_DESK, address(sleeve), _shieldData(address(aapl), raw, bytes32(salt)), new bytes32[](0), 0) {
            return true;
        } catch {
            return false;
        }
    }

    function mintAapl(address to, uint256 raw) external {
        aapl.mint(to, raw);
    }

    function warpBy(uint256 dt) external {
        _warp(block.timestamp + dt);
    }

    function refreshWith(uint256 navUsd, bytes32[8] memory nfs) external {
        IPrivateSleeve.PrivateClose memory p;
        p.root = pool.currentRoot();
        p.navUsd = navUsd;
        p.nullifiers = nfs;
        try pc.refreshPrivateBook(p) {} catch {}
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 40
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_bookNeverAboveRealSleeveHoldings() public view {
        assertLe(sleeve.bookUsd(), handler.ownUnspentUsd() + handler.ownHeldUsd(), "private book above real holdings");
    }
}

