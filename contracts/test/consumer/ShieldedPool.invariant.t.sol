// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../../src/consumer/ShieldedPool.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockStockToken} from "../../src/testnet/MockStockToken.sol";
import {SwitchVerifier} from "./ShieldedPoolBase.sol";

/// Drives the pool like honest provers would (the verifier stand-in accepts; the handler only submits spends
/// that a valid proof could back: conserved values, real unspent notes) and keeps a shadow ledger of notes.
contract ShieldedPoolHandler is Test {
    struct Note {
        address asset;
        uint256 raw;
        bytes32 nullifier;
    }

    struct Queued {
        uint256 id;
        address asset;
        uint256 raw;
        address origin;
    }

    ShieldedPool public pool;
    MockUSDG public usdg;
    MockStockToken public stock;
    address[3] public actors;

    Note[] public unspent;
    Queued[] public queued;
    bytes32[] public spentNullifiers;
    uint256 private nonce;
    uint256 public doubleSpendAccepted;
    uint256 public withdrawn;

    constructor(ShieldedPool pool_, MockUSDG usdg_, MockStockToken stock_) {
        pool = pool_;
        usdg = usdg_;
        stock = stock_;
        for (uint256 i; i < 3; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
    }

    function _asset(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdg) : address(stock);
    }

    function _fresh() internal returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("n", ++nonce))) >> 4);
    }

    function deposit(uint256 actorSeed, uint256 assetSeed, uint256 raw) external {
        address a = _asset(assetSeed);
        raw = bound(raw, 1, a == address(usdg) ? 1e12 : 1e24);
        address who = actors[actorSeed % 3];
        vm.prank(who);
        uint256 id = pool.deposit(a, raw, _fresh(), _fresh(), "");
        queued.push(Queued(id, a, raw, who));
    }

    function refund(uint256 seed) external {
        if (queued.length == 0) return;
        uint256 k = seed % queued.length;
        Queued memory q = queued[k];
        vm.prank(q.origin);
        pool.refundPending(q.id);
        queued[k] = queued[queued.length - 1];
        queued.pop();
    }

    function insert() external {
        vm.warp(block.timestamp + 1 hours);
        try pool.insertPending(type(uint256).max) {} catch {}
        for (uint256 k; k < queued.length; ++k) {
            unspent.push(Note(queued[k].asset, queued[k].raw, _fresh()));
        }
        delete queued;
    }

    function transfer(uint256 i, uint256 j, uint256 split) external {
        if (unspent.length == 0) return;
        i %= unspent.length;
        Note memory a = unspent[i];
        Note memory b = Note(a.asset, 0, _fresh()); // dummy input
        bool two = unspent.length > 1 && unspent[j % unspent.length].asset == a.asset && j % unspent.length != i;
        if (two) b = unspent[j % unspent.length];
        uint256 total = a.raw + b.raw;
        uint256 out0 = bound(split, 0, total);

        ShieldedPool.PublicTransfer memory t;
        t.root = pool.currentRoot();
        t.nullifiers = [a.nullifier, b.nullifier];
        t.outCommitments = [_fresh(), _fresh()];
        t.asset = a.asset;
        bytes[2] memory e;
        pool.transfer("", t, e);

        _remove(a.nullifier);
        if (two) _remove(b.nullifier);
        spentNullifiers.push(a.nullifier);
        spentNullifiers.push(b.nullifier);
        unspent.push(Note(a.asset, out0, _fresh()));
        unspent.push(Note(a.asset, total - out0, _fresh()));
    }

    function withdraw(uint256 i, uint256 amount, uint256 fee, uint256 actorSeed) external {
        if (unspent.length == 0) return;
        Note memory n = unspent[i % unspent.length];
        amount = bound(amount, 0, n.raw);
        fee = bound(fee, 0, amount);
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = n.nullifier;
        w.changeCommitment = _fresh();
        w.asset = n.asset;
        w.amount = amount;
        w.recipient = actors[actorSeed % 3];
        w.relayerFee = fee;
        vm.prank(actors[(actorSeed + 1) % 3]);
        pool.withdraw("", w);
        _remove(n.nullifier);
        spentNullifiers.push(n.nullifier);
        unspent.push(Note(n.asset, n.raw - amount, _fresh()));
        withdrawn += amount;
    }

    /// Replays an already spent nullifier: must never succeed.
    function doubleSpend(uint256 k, uint256 actorSeed) external {
        if (spentNullifiers.length == 0) return;
        bytes32 n = spentNullifiers[k % spentNullifiers.length];
        ShieldedPool.PublicWithdraw memory w;
        w.root = pool.currentRoot();
        w.nullifier = n;
        w.changeCommitment = _fresh();
        w.asset = address(usdg);
        w.amount = 0;
        w.recipient = actors[actorSeed % 3];
        try pool.withdraw("", w) {
            ++doubleSpendAccepted;
        } catch {}
    }

    function rebaseStock(uint256 m) external {
        stock.setUiMultiplier(bound(m, 1e17, 1e19));
    }

    function _remove(bytes32 nullifier) internal {
        for (uint256 k; k < unspent.length; ++k) {
            if (unspent[k].nullifier == nullifier) {
                unspent[k] = unspent[unspent.length - 1];
                unspent.pop();
                return;
            }
        }
    }

    /// Shadow value of `asset`: unspent notes + queued deposits.
    function shadow(address asset) external view returns (uint256 sum) {
        for (uint256 k; k < unspent.length; ++k) {
            if (unspent[k].asset == asset) sum += unspent[k].raw;
        }
        for (uint256 k; k < queued.length; ++k) {
            if (queued[k].asset == asset) sum += queued[k].raw;
        }
    }
}

/// SCOPE: this suite runs the pool with a MOCK verifier (`SwitchVerifier`, which accepts every proof), so it
/// checks the pool's ACCOUNTING under random honest traffic, not proof soundness:
///   - the pool's balance covers every unspent note (plus pending deposits), per asset, and `shielded` is exact;
///   - no nullifier is ever spent twice.
/// It cannot catch a verifier that accepts a forged proof or a circuit that under-constrains a value. That is
/// covered by the tests that use the real generated UltraHonk verifiers with real proof fixtures:
///   - test/consumer/ShieldedPoolProofs.t.sol (ShieldedPoolProofsTest): the pool with the real Transfer and
///     Withdraw verifiers end to end on SDK-made proofs, replay, swapped outputs, recipient/fee/amount binding,
///     unknown roots, relayer tampering with encrypted notes;
///   - test/consumer/verifiers/HiddenVerifiers.t.sol (TransferVerifierTest, WithdrawVerifierTest,
///     SwapVerifierTest, SettleVerifierTest): each verifier accepts its client proof and rejects every flipped
///     public input, a tampered proof, a wrong input count, and relayer changes to recipient, fee or terms;
///   - test/consumer/ThresholdVerifier.t.sol (ThresholdVerifierTest): the threshold holdings/savings verifiers.
contract ShieldedPoolInvariantTest is Test {
    ShieldedPool pool;
    ShieldedPoolHandler h;
    MockUSDG usdg;
    MockStockToken stock;

    function setUp() public {
        vm.warp(1_800_000_000);
        address owner = makeAddr("owner");
        usdg = new MockUSDG();
        stock = new MockStockToken("Mock TSLA", "mTSLA");
        pool = new ShieldedPool(new SwitchVerifier(), new SwitchVerifier(), owner, 48 hours);
        vm.startPrank(owner);
        pool.proposeCap(address(usdg), type(uint128).max);
        pool.proposeCap(address(stock), type(uint128).max);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.applyCap(address(usdg));
        pool.applyCap(address(stock));
        h = new ShieldedPoolHandler(pool, usdg, stock);
        for (uint256 i; i < 3; ++i) {
            address a = h.actors(i);
            usdg.mint(a, 1e15);
            stock.mint(a, 1e30);
            vm.startPrank(a);
            usdg.approve(address(pool), type(uint256).max);
            stock.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
        stock.transferOwnership(address(h)); // rebaseStock changes the multiplier mid-run
        targetContract(address(h));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 60
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    /// Σ pool balances >= Σ unspent note values (+ pending deposits), per asset; accounting is exact.
    function invariant_poolCoversUnspentNotes() public view {
        assertGe(usdg.balanceOf(address(pool)), h.shadow(address(usdg)));
        assertGe(stock.balanceOf(address(pool)), h.shadow(address(stock)));
        assertEq(pool.shielded(address(usdg)), h.shadow(address(usdg)));
        assertEq(pool.shielded(address(stock)), h.shadow(address(stock)));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 60
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 500
    function invariant_noNullifierSpentTwice() public view {
        assertEq(h.doubleSpendAccepted(), 0);
    }
}
