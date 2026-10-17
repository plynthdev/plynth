// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShieldedPool, IHonkVerifier} from "./ShieldedPool.sol";
import {Poseidon2} from "./verifiers/Poseidon2.sol";
import {HiddenConstants} from "./verifiers/HiddenConstants.sol";

/// Checks Hidden Vault threshold proofs (circuits/threshold_holdings, circuits/threshold_savings) against
/// ShieldedPool state. Stateless for verifiers: `checkHoldings` / `checkSavings` are views that revert with the
/// reason a proof is not accepted. The only state here is the deposit tree that savings proofs open against.
///
/// Holdings: the proof's root must be a root ShieldedPool has published, and none of the proof's nullifiers may
/// be spent now. Nullifiers are derived inside the circuit, so a spent note cannot be counted. Padding slots
/// output a zero nullifier; the verifier learns how many slots were padding.
///
/// Accepted risk (external audit L-11): a holdings proof publishes the nullifier of every note it counts, and
/// that nullifier appears again on-chain (NullifierSpent) when the note is spent, so the verifier, or anyone it
/// shares the proof with, links that later spend to the prover. Proving non-membership in the spent set without
/// revealing nullifiers needs a nullifier-set accumulator, a redesign not built here. Mitigation: right after
/// the verifier has checked a proof, the prover re-shields the counted notes to itself (SDK
/// `proveUnlinkHoldings`, one private transfer per two notes); the verifier then sees only that those notes were
/// spent, and nothing after links to the proof. The proof stops verifying at that point (its notes are spent),
/// so verifiers should check a proof when it is presented.
///
/// Savings: ShieldedPool has no record of which leaves were deposits (transfer outputs and change notes look the
/// same), so this contract keeps its own append-only Poseidon2 tree of deposit commitments. Anyone calls
/// `syncDeposits` to copy finished pool deposits (state Inserted, in pending-id order) into it; refunded deposits
/// are skipped. A savings proof counts the owner's deposits appended between two published deposit-tree roots.
///
/// Nonces: `nonceFor(verifier, requestId)` binds a proof to one verifier's request on this chain and contract.
/// A verifier (off-chain service or a gating contract passing address(this)) recomputes the nonce for itself, so
/// a proof made for verifier A fails for verifier B.
contract ThresholdVerifier {
    uint256 public constant MAX_NOTES = 8;
    uint256 public constant TREE_DEPTH = 20; // == HiddenConstants.TREE_DEPTH
    uint256 public constant MAX_LEAVES = 1 << TREE_DEPTH;
    uint256 public constant MAX_THRESHOLD = type(uint128).max; // circuits range-check the threshold to 128 bits
    bytes32 public constant NONCE_DOMAIN = keccak256("plynth.threshold.nonce.v1");
    uint256 private constant P = Poseidon2.P;

    struct HoldingsClaim {
        bytes32 root; // a ShieldedPool root
        address asset;
        uint256 threshold; // raw units
        bytes32[MAX_NOTES] nullifiers; // 0 = padding slot
    }

    struct SavingsClaim {
        bytes32 rootFrom; // deposit-tree roots (this contract)
        bytes32 rootTo;
        address asset;
        uint256 threshold; // raw units
    }

    struct DepositRoot {
        uint64 seq; // 1 = the empty tree at deploy
        uint64 size; // deposits in the tree at this root
        uint64 blockNumber;
        uint64 timestamp;
    }

    /// What an accepted holdings proof tells the verifier besides "asset, threshold met".
    struct HoldingsResult {
        uint256 poolRootSeq; // 0 = a full tree's archived final root (older than every published root)
        uint256 notes; // real slots; MAX_NOTES - notes were padding
    }

    ShieldedPool public immutable pool;
    IHonkVerifier public immutable holdingsVerifier;
    IHonkVerifier public immutable savingsVerifier;

    uint256[TREE_DEPTH] private _filled;
    uint256 public depositCount;
    bytes32 public depositRoot;
    uint256 public depositRootCount;
    mapping(bytes32 root => DepositRoot) private _depositRoots;
    /// Next ShieldedPool pending id to look at.
    uint256 public nextPendingSynced;

    event DepositLeaf(uint256 indexed depositIndex, uint256 indexed pendingId, bytes32 commitment);
    event DepositRootUpdated(bytes32 root, uint256 size);

    error ZeroAddress();
    error NothingToSync();
    error TreeFull();
    error UnknownRoot(bytes32 root);
    error UnknownDepositRoot(bytes32 root);
    error BadWindow();
    error BadThreshold();
    error NotAFieldElement();
    error NullifierSpent(bytes32 nullifier);
    error DuplicateNullifier(bytes32 nullifier);
    error InvalidProof();

    constructor(ShieldedPool pool_, IHonkVerifier holdingsVerifier_, IHonkVerifier savingsVerifier_) {
        if (
            address(pool_) == address(0) || address(holdingsVerifier_) == address(0)
                || address(savingsVerifier_) == address(0)
        ) revert ZeroAddress();
        pool = pool_;
        holdingsVerifier = holdingsVerifier_;
        savingsVerifier = savingsVerifier_;
        _publish(bytes32(HiddenConstants.EMPTY_ROOT));
    }

    // ---------------------------------------------------------------- deposit tree

    /// Anyone: copies up to `maxCount` finished pool deposits (pending ids below pool.nextPending(), which are all
    /// Inserted or Refunded) into the deposit tree. Refunded entries are skipped and count toward `maxCount`.
    function syncDeposits(uint256 maxCount) external returns (uint256 added) {
        uint256 id = nextPendingSynced;
        uint256 start = id;
        uint256 end = pool.nextPending();
        uint256 node;
        while (id < end && maxCount != 0) {
            ShieldedPool.Pending memory p = pool.pending(id);
            if (p.state == ShieldedPool.PendingState.Inserted) {
                node = _insert(p.commitment, id);
                ++added;
            }
            ++id;
            --maxCount;
        }
        if (id == start) revert NothingToSync();
        nextPendingSynced = id;
        if (added != 0) _publish(bytes32(node));
    }

    /// Finished pool deposits not yet copied (an upper bound on what syncDeposits would add).
    function unsyncedDeposits() external view returns (uint256) {
        return pool.nextPending() - nextPendingSynced;
    }

    function depositRootInfo(bytes32 root) external view returns (DepositRoot memory) {
        return _depositRoots[root];
    }

    // ---------------------------------------------------------------- nonces

    /// The verifier_nonce a prover must use for `verifier`'s request `requestId` (never 0 in practice).
    function nonceFor(address verifier, bytes32 requestId) public view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(NONCE_DOMAIN, block.chainid, address(this), verifier, requestId))) % P);
    }

    // ---------------------------------------------------------------- checks (views)

    /// Reverts unless `proof` shows unspent notes of `claim.asset` worth >= `claim.threshold` at `claim.root`,
    /// made for (`verifier`, `requestId`).
    function checkHoldings(bytes calldata proof, HoldingsClaim calldata claim, address verifier, bytes32 requestId)
        public
        view
        returns (HoldingsResult memory r)
    {
        if (claim.asset == address(0)) revert ZeroAddress();
        if (claim.threshold > MAX_THRESHOLD) revert BadThreshold();
        // Provable exactly where spendable (review I-3): any root the pool accepts for spends (`isKnownRoot`),
        // including a full tree's archived final root, which was never published and so has no sequence number.
        if (!pool.isKnownRoot(claim.root)) revert UnknownRoot(claim.root);
        r.poolRootSeq = pool.rootSeq(claim.root); // 0 for an archived-only root

        bytes32[] memory inputs = new bytes32[](4 + MAX_NOTES);
        inputs[0] = claim.root;
        inputs[1] = bytes32(uint256(uint160(claim.asset)));
        inputs[2] = bytes32(claim.threshold);
        inputs[3] = nonceFor(verifier, requestId);
        for (uint256 i; i < MAX_NOTES; ++i) {
            bytes32 n = claim.nullifiers[i];
            inputs[4 + i] = n;
            if (n == 0) continue;
            // The UltraHonk verifier reduces inputs mod p: n + p would pass the proof but miss the spent map.
            if (uint256(n) >= P) revert NotAFieldElement();
            for (uint256 j; j < i; ++j) {
                if (claim.nullifiers[j] == n) revert DuplicateNullifier(n);
            }
            if (pool.nullifierSpent(n)) revert NullifierSpent(n);
            ++r.notes;
        }
        _verify(holdingsVerifier, proof, inputs);
    }

    /// Reverts unless `proof` shows the owner's deposits of `claim.asset` appended to the deposit tree between
    /// `claim.rootFrom` and `claim.rootTo` add up to >= `claim.threshold`, made for (`verifier`, `requestId`).
    /// Returns both roots' records (block, timestamp, size): the time window the verifier learns.
    function checkSavings(bytes calldata proof, SavingsClaim calldata claim, address verifier, bytes32 requestId)
        public
        view
        returns (DepositRoot memory from, DepositRoot memory to)
    {
        if (claim.asset == address(0)) revert ZeroAddress();
        if (claim.threshold > MAX_THRESHOLD) revert BadThreshold();
        from = _depositRoots[claim.rootFrom];
        to = _depositRoots[claim.rootTo];
        if (from.seq == 0) revert UnknownDepositRoot(claim.rootFrom);
        if (to.seq == 0) revert UnknownDepositRoot(claim.rootTo);
        if (from.seq > to.seq) revert BadWindow();

        bytes32[] memory inputs = new bytes32[](5);
        inputs[0] = claim.rootFrom;
        inputs[1] = claim.rootTo;
        inputs[2] = bytes32(uint256(uint160(claim.asset)));
        inputs[3] = bytes32(claim.threshold);
        inputs[4] = nonceFor(verifier, requestId);
        _verify(savingsVerifier, proof, inputs);
    }

    /// Boolean forms for callers that only need yes/no.
    function verifyHoldings(bytes calldata proof, HoldingsClaim calldata claim, address verifier, bytes32 requestId)
        external
        view
        returns (bool)
    {
        try this.checkHoldings(proof, claim, verifier, requestId) {
            return true;
        } catch {
            return false;
        }
    }

    function verifySavings(bytes calldata proof, SavingsClaim calldata claim, address verifier, bytes32 requestId)
        external
        view
        returns (bool)
    {
        try this.checkSavings(proof, claim, verifier, requestId) {
            return true;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- internal

    function _insert(bytes32 leaf, uint256 pendingId) private returns (uint256 node) {
        uint256 index = depositCount;
        if (index >= MAX_LEAVES) revert TreeFull();
        node = uint256(leaf);
        uint256 pos = index;
        for (uint256 level; level < TREE_DEPTH; ++level) {
            if (pos & 1 == 0) {
                _filled[level] = node;
                node = Poseidon2.hash2(node, HiddenConstants.zeros(level));
            } else {
                node = Poseidon2.hash2(_filled[level], node);
            }
            pos >>= 1;
        }
        depositCount = index + 1;
        emit DepositLeaf(index, pendingId, leaf);
    }

    function _publish(bytes32 root) private {
        uint256 seq = depositRootCount + 1;
        depositRootCount = seq;
        depositRoot = root;
        _depositRoots[root] = DepositRoot({
            seq: uint64(seq),
            size: uint64(depositCount),
            blockNumber: uint64(block.number),
            timestamp: uint64(block.timestamp)
        });
        emit DepositRootUpdated(root, depositCount);
    }

    function _verify(IHonkVerifier v, bytes calldata proof, bytes32[] memory inputs) private view {
        bool ok;
        try v.verify(proof, inputs) returns (bool res) {
            ok = res;
        } catch {
            ok = false;
        }
        if (!ok) revert InvalidProof();
    }
}
