// Hidden Vault note model, shared by the transfer and withdraw circuits.
//
//   ownerPk    = H(spendingSecret)
//   commitment = H(assetId, rawAmount, ownerPk, blinding)
//   nullifier  = H(commitment, spendingSecret, leafIndex)
//   node       = H(left, right)
//
// H is the Poseidon2 sponge (bn254, t = 4, rate 3, capacity 1, IV = len << 64) exactly as
// in Noir's stdlib Poseidon2Hasher, so contracts/src/consumer/verifiers/Poseidon2.sol can
// reproduce it on-chain.

pub mod constants;

pub use constants::{TREE_DEPTH, ZERO_LEAF};

global RATE: u32 = 3;
global TWO_POW_64: Field = 18446744073709551616;

/// Poseidon2 sponge hash of a fixed-length input.
pub fn hash<let N: u32>(inputs: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (N as Field) * TWO_POW_64];
    for i in 0..N / RATE {
        for j in 0..RATE {
            state[j] += inputs[i * RATE + j];
        }
        state = std::hash::poseidon2_permutation(state);
    }
    let absorbed = (N / RATE) * RATE;
    for i in 0..N % RATE {
        state[i] += inputs[absorbed + i];
    }
    std::hash::poseidon2_permutation(state)[0]
}

pub fn owner_pk(spending_secret: Field) -> Field {
    hash([spending_secret])
}

pub fn commitment(asset_id: Field, raw_amount: Field, owner_pk: Field, blinding: Field) -> Field {
    hash([asset_id, raw_amount, owner_pk, blinding])
}

pub fn nullifier(commitment: Field, spending_secret: Field, leaf_index: Field) -> Field {
    hash([commitment, spending_secret, leaf_index])
}

pub fn hash_node(left: Field, right: Field) -> Field {
    hash([left, right])
}

/// Root of the tree containing `leaf` at `index` with sibling `path` (leaf level first).
/// Constrains `index < 2^TREE_DEPTH`.
pub fn merkle_root(leaf: Field, index: Field, path: [Field; TREE_DEPTH]) -> Field {
    let bits: [bool; TREE_DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        node = if bits[i] {
            hash_node(path[i], node)
        } else {
            hash_node(node, path[i])
        };
    }
    node
}

/// zeros[i] = root of an empty subtree of height i; zeros[TREE_DEPTH] is the empty-tree root.
pub fn zero_hashes() -> [Field; TREE_DEPTH + 1] {
    let mut zeros = [ZERO_LEAF; TREE_DEPTH + 1];
    for i in 0..TREE_DEPTH {
        zeros[i + 1] = hash_node(zeros[i], zeros[i]);
    }
    zeros
}

/// Sibling path of any leaf in an empty tree.
pub fn empty_path() -> [Field; TREE_DEPTH] {
    let zeros = zero_hashes();
    let mut path = [0; TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        path[i] = zeros[i];
    }
    path
}

/// Test helper: a tree holding `leaves` at indices 0..M with everything else empty.
/// Returns (root, paths[k]) for each leaf k.
pub fn small_tree<let M: u32>(leaves: [Field; M]) -> (Field, [[Field; TREE_DEPTH]; M]) {
    let zeros = zero_hashes();
    let mut paths = [[0; TREE_DEPTH]; M];
    // level holds the current row (only the first `width` entries are non-empty).
    let mut level = [ZERO_LEAF; M];
    for k in 0..M {
        level[k] = leaves[k];
    }
    let mut width = M;
    for d in 0..TREE_DEPTH {
        for k in 0..M {
            let pos = k >> d;
            let sib = pos ^ 1;
            paths[k][d] = if sib < width { level[sib] } else { zeros[d] };
        }
        let next_width = (width + 1) / 2;
        let mut next = [0; M];
        for p in 0..M {
            if p < next_width {
                let l = level[2 * p];
                let r = if 2 * p + 1 < width { level[2 * p + 1] } else { zeros[d] };
                next[p] = hash_node(l, r);
            }
        }
        level = next;
        width = next_width;
    }
    (level[0], paths)
}

#[test]
fn sponge_matches_stdlib_known_digest() {
    // Same vector as noir_stdlib/src/hash/poseidon2.nr finish_ref_matches_known_digest.
    assert(hash([1, 2, 3, 4, 5]) == 0x2247be7014a54d17342a7ef677f58d28877780d203860396967f5d0a18d259db); // not-a-key
}

#[test]
fn merkle_root_of_empty_leaf_is_empty_root() {
    let zeros = zero_hashes();
    let path = empty_path();
    assert(merkle_root(ZERO_LEAF, 0, path) == zeros[TREE_DEPTH]);
    assert(merkle_root(ZERO_LEAF, 1048575, path) == zeros[TREE_DEPTH]);
}

#[test]
fn small_tree_paths_open_to_root() {
    let leaves = [11, 22, 33];
    let (root, paths) = small_tree(leaves);
    for k in 0..3 {
        assert(merkle_root(leaves[k], k as Field, paths[k]) == root);
    }
    assert(merkle_root(leaves[0], 1, paths[0]) != root);
}

#[test(should_fail)]
fn merkle_index_must_fit_depth() {
    let path = empty_path();
    let _ = merkle_root(ZERO_LEAF, 1048576, path);
}
