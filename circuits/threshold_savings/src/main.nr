// Threshold proof (savings history): "deposits to my ownerPk of `asset_id` made between two deposit-tree roots
// add up to at least `threshold` raw units", without revealing the deposits, their count or the exact sum.
//
// The deposit tree is ThresholdVerifier's append-only Poseidon2 tree of ShieldedPool deposit commitments (one leaf
// per inserted deposit, in pool insertion order; transfer outputs and change notes are never in it, so moving
// notes around cannot inflate savings). Same depth, zero leaf and hash as the note tree.
//
// Window: leaf `from_index` is still empty in the tree at `root_from`, so every leaf at index >= from_index was
// appended after root_from. Every counted deposit sits at index >= from_index in the tree at `root_to`.
//
// Public: root_from, root_to, asset_id, threshold, verifier_nonce (binds the proof to one verifier request).
// Private: spending secret, from_index + its path in root_from, up to MAX_DEPOSITS deposits.

use hidden::{commitment, merkle_root, owner_pk, TREE_DEPTH, ZERO_LEAF};

pub global MAX_DEPOSITS: u32 = 8;
global TWO_POW_20: Field = 1048576;
global TWO_POW_132: Field = 5444517870735015415413993718908291383296;

pub struct Slot {
    is_real: bool,
    amount: Field,
    blinding: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

fn main(
    root_from: pub Field,
    root_to: pub Field,
    asset_id: pub Field,
    threshold: pub Field,
    verifier_nonce: pub Field,
    secret: Field,
    from_index: Field,
    from_path: [Field; TREE_DEPTH],
    deposits: [Slot; MAX_DEPOSITS],
) {
    asset_id.assert_max_bit_size::<160>();
    threshold.assert_max_bit_size::<128>();
    assert(verifier_nonce != 0, "verifier nonce required");
    // Also constrains from_index < 2^20.
    assert(merkle_root(ZERO_LEAF, from_index, from_path) == root_from, "window start not empty at root_from");

    let pk = owner_pk(secret);
    let mut sum: Field = 0;
    for i in 0..MAX_DEPOSITS {
        let d = deposits[i];
        if d.is_real {
            d.amount.assert_max_bit_size::<128>();
            let c = commitment(asset_id, d.amount, pk, d.blinding);
            // merkle_root constrains d.index < 2^20, so index - from_index < 2^20 iff index >= from_index.
            assert(merkle_root(c, d.index, d.path) == root_to, "deposit not in tree");
            assert((d.index - from_index).lt(TWO_POW_20), "deposit before window");
            for j in 0..i {
                if deposits[j].is_real {
                    assert(deposits[j].index != d.index, "deposit counted twice");
                }
            }
            sum += d.amount;
        }
    }
    assert((sum - threshold).lt(TWO_POW_132), "savings below threshold");
}

// ---------------------------------------------------------------- tests

global ASSET: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global SECRET: Field = 101;
global NONCE: Field = 777;

struct Case {
    root_from: Field,
    root_to: Field,
    asset: Field,
    threshold: Field,
    nonce: Field,
    secret: Field,
    from_index: Field,
    from_path: [Field; TREE_DEPTH],
    deposits: [Slot; MAX_DEPOSITS],
}

fn pad() -> Slot {
    Slot { is_real: false, amount: 0, blinding: 0, index: 0, path: [0; TREE_DEPTH] }
}

// Deposit tree over time: leaf 0 = mine 100 (before the window), leaf 1 = someone else's 5000;
// root_from is taken here (2 leaves). Then leaf 2 = mine 200, leaf 3 = mine 300 -> root_to (4 leaves).
// Window deposits of mine: 200 + 300 = 500.
fn case(threshold: Field) -> Case {
    let pk = owner_pk(SECRET);
    let leaves = [
        commitment(ASSET, 100, pk, 11),
        commitment(ASSET, 5000, owner_pk(55), 3),
        commitment(ASSET, 200, pk, 12),
        commitment(ASSET, 300, pk, 13),
    ];
    let (root_to, paths) = hidden::small_tree(leaves);
    // Tree at root_from: leaves 0, 1 and an empty leaf at index 2.
    let (root_from, from_paths) = hidden::small_tree([leaves[0], leaves[1], ZERO_LEAF]);
    let mut deposits = [pad(); MAX_DEPOSITS];
    deposits[0] = Slot { is_real: true, amount: 200, blinding: 12, index: 2, path: paths[2] };
    deposits[1] = Slot { is_real: true, amount: 300, blinding: 13, index: 3, path: paths[3] };
    Case {
        root_from,
        root_to,
        asset: ASSET,
        threshold,
        nonce: NONCE,
        secret: SECRET,
        from_index: 2,
        from_path: from_paths[2],
        deposits,
    }
}

fn run(c: Case) {
    main(
        c.root_from,
        c.root_to,
        c.asset,
        c.threshold,
        c.nonce,
        c.secret,
        c.from_index,
        c.from_path,
        c.deposits,
    );
}

#[test]
fn true_statement_exact() {
    run(case(500));
}

#[test]
fn true_statement_below() {
    run(case(250));
}

#[test]
fn whole_history_from_the_empty_tree() {
    // root_from = empty tree root, from_index 0: every deposit counts (100 + 200 + 300).
    let mut c = case(600);
    c.root_from = hidden::zero_hashes()[TREE_DEPTH];
    c.from_index = 0;
    c.from_path = hidden::empty_path();
    let pk = owner_pk(SECRET);
    let leaves = [
        commitment(ASSET, 100, pk, 11),
        commitment(ASSET, 5000, owner_pk(55), 3),
        commitment(ASSET, 200, pk, 12),
        commitment(ASSET, 300, pk, 13),
    ];
    let (_, paths) = hidden::small_tree(leaves);
    c.deposits[2] = Slot { is_real: true, amount: 100, blinding: 11, index: 0, path: paths[0] };
    run(c);
}

#[test(should_fail_with = "savings below threshold")]
fn threshold_above_actual_fails() {
    run(case(501));
}

#[test(should_fail_with = "deposit before window")]
fn deposit_before_window_rejected() {
    // Counting leaf 0 (deposited before root_from) is refused.
    let mut c = case(600);
    let pk = owner_pk(SECRET);
    let leaves = [
        commitment(ASSET, 100, pk, 11),
        commitment(ASSET, 5000, owner_pk(55), 3),
        commitment(ASSET, 200, pk, 12),
        commitment(ASSET, 300, pk, 13),
    ];
    let (_, paths) = hidden::small_tree(leaves);
    c.deposits[2] = Slot { is_real: true, amount: 100, blinding: 11, index: 0, path: paths[0] };
    run(c);
}

#[test(should_fail_with = "window start not empty at root_from")]
fn window_start_must_be_empty() {
    // Pretending the window starts at leaf 1 (occupied at root_from) is refused.
    let mut c = case(500);
    let (_, from_paths) = hidden::small_tree([
        commitment(ASSET, 100, owner_pk(SECRET), 11),
        commitment(ASSET, 5000, owner_pk(55), 3),
        ZERO_LEAF,
    ]);
    c.from_index = 1;
    c.from_path = from_paths[1];
    run(c);
}

#[test(should_fail_with = "deposit counted twice")]
fn same_deposit_twice() {
    let mut c = case(400);
    c.deposits[1] = c.deposits[0];
    run(c);
}

#[test(should_fail_with = "deposit not in tree")]
fn someone_elses_deposit() {
    let mut c = case(500);
    c.deposits[2] = Slot { is_real: true, amount: 5000, blinding: 3, index: 1, path: c.deposits[0].path };
    run(c);
}

#[test(should_fail_with = "deposit not in tree")]
fn foreign_secret() {
    let mut c = case(500);
    c.secret = 999;
    run(c);
}

#[test(should_fail_with = "verifier nonce required")]
fn zero_nonce() {
    let mut c = case(500);
    c.nonce = 0;
    run(c);
}
