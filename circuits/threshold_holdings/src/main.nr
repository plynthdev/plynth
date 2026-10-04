// Threshold proof (holdings): "I hold unspent notes of `asset_id` worth at least `threshold` raw units in the
// tree at `root`", without revealing which notes, how many (beyond the padding count) or the exact sum.
//
// Public: root, asset_id, threshold, verifier_nonce, nullifier_hashes[8].
//   - root: any root ShieldedPool has published (ThresholdVerifier checks rootSeq != 0).
//   - verifier_nonce: chosen by the verifier (ThresholdVerifier.nonceFor), binds the proof to one request so a
//     proof made for verifier A is useless to verifier B.
//   - nullifier_hashes: each real slot outputs its note's nullifier (derived here from the spending secret, so
//     it is the note's real nullifier), and the verifier checks none is spent. Padding slots output 0.
// Private: the spending secret and up to MAX_NOTES notes (amount, blinding, leaf index, Merkle path).

use hidden::{commitment, merkle_root, nullifier, owner_pk, TREE_DEPTH};

pub global MAX_NOTES: u32 = 8;
global TWO_POW_132: Field = 5444517870735015415413993718908291383296;

pub struct Slot {
    is_real: bool,
    amount: Field,
    blinding: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

fn main(
    root: pub Field,
    asset_id: pub Field,
    threshold: pub Field,
    verifier_nonce: pub Field,
    nullifier_hashes: pub [Field; MAX_NOTES],
    secret: Field,
    notes: [Slot; MAX_NOTES],
) {
    asset_id.assert_max_bit_size::<160>();
    threshold.assert_max_bit_size::<128>();
    assert(verifier_nonce != 0, "verifier nonce required");

    let pk = owner_pk(secret);
    let mut sum: Field = 0;
    for i in 0..MAX_NOTES {
        let n = notes[i];
        if n.is_real {
            n.amount.assert_max_bit_size::<128>();
            let c = commitment(asset_id, n.amount, pk, n.blinding);
            assert(merkle_root(c, n.index, n.path) == root, "note not in tree");
            assert(nullifier(c, secret, n.index) == nullifier_hashes[i], "bad nullifier");
            for j in 0..i {
                if notes[j].is_real {
                    assert(notes[j].index != n.index, "note counted twice");
                }
            }
            sum += n.amount;
        } else {
            assert(nullifier_hashes[i] == 0, "padding slot must output a zero nullifier");
        }
    }
    // sum < 8 * 2^128 and threshold < 2^128: sum - threshold stays below 2^132 exactly when sum >= threshold
    // (otherwise it wraps to p - (threshold - sum)).
    assert((sum - threshold).lt(TWO_POW_132), "holdings below threshold");
}

// ---------------------------------------------------------------- tests

global ASSET: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global OTHER_ASSET: Field = 0x0000000000000000000000000000000000000a55;
global SECRET: Field = 101;
global NONCE: Field = 777;
global TWO_POW_128: Field = 340282366920938463463374607431768211456;

struct Case {
    root: Field,
    asset: Field,
    threshold: Field,
    nonce: Field,
    nullifiers: [Field; MAX_NOTES],
    secret: Field,
    notes: [Slot; MAX_NOTES],
}

fn pad() -> Slot {
    Slot { is_real: false, amount: 0, blinding: 0, index: 0, path: [0; TREE_DEPTH] }
}

// Tree: leaf 0 = someone else's note, leaves 1..4 = mine (100, 200, 300, 400), leaf 5 = mine in another asset.
// The case uses `count` of my notes (leaves 1..count).
fn case(count: u32, threshold: Field) -> Case {
    let pk = owner_pk(SECRET);
    let mine = [
        commitment(ASSET, 100, pk, 11),
        commitment(ASSET, 200, pk, 12),
        commitment(ASSET, 300, pk, 13),
        commitment(ASSET, 400, pk, 14),
    ];
    let leaves = [
        commitment(ASSET, 5000, owner_pk(55), 3),
        mine[0],
        mine[1],
        mine[2],
        mine[3],
        commitment(OTHER_ASSET, 9999, pk, 15),
    ];
    let (root, paths) = hidden::small_tree(leaves);
    let mut notes = [pad(); MAX_NOTES];
    let mut nullifiers = [0; MAX_NOTES];
    for k in 0..4 {
        if k < count {
            notes[k] = Slot {
                is_real: true,
                amount: (k as Field + 1) * 100,
                blinding: 11 + k as Field,
                index: k as Field + 1,
                path: paths[k + 1],
            };
            nullifiers[k] = nullifier(mine[k], SECRET, k as Field + 1);
        }
    }
    Case { root, asset: ASSET, threshold, nonce: NONCE, nullifiers, secret: SECRET, notes }
}

fn run(c: Case) {
    main(c.root, c.asset, c.threshold, c.nonce, c.nullifiers, c.secret, c.notes);
}

#[test]
fn true_statement_exact_sum() {
    run(case(4, 1000));
}

#[test]
fn true_statement_below_sum() {
    run(case(2, 250));
}

#[test]
fn single_note_with_padding() {
    run(case(1, 100));
}

#[test]
fn padding_in_the_middle() {
    let mut c = case(3, 400);
    c.notes[1] = pad();
    c.nullifiers[1] = 0;
    run(c);
}

#[test]
fn zero_threshold_is_trivially_met() {
    run(case(1, 0));
}

#[test(should_fail_with = "holdings below threshold")]
fn threshold_above_actual_fails() {
    run(case(4, 1001));
}

#[test(should_fail_with = "holdings below threshold")]
fn padding_adds_nothing() {
    let mut c = case(4, 1000);
    c.notes[3] = pad();
    c.nullifiers[3] = 0;
    run(c);
}

#[test(should_fail_with = "note counted twice")]
fn same_note_twice() {
    let mut c = case(2, 400);
    c.notes[1] = c.notes[0];
    c.nullifiers[1] = c.nullifiers[0];
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn wrong_nullifier() {
    let mut c = case(2, 300);
    c.nullifiers[1] = c.nullifiers[1] + 1;
    run(c);
}

#[test(should_fail_with = "padding slot must output a zero nullifier")]
fn padding_with_nonzero_nullifier() {
    let mut c = case(2, 300);
    c.nullifiers[5] = 1;
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn foreign_secret_cannot_count_notes() {
    let mut c = case(2, 300);
    c.secret = 999;
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn wrong_asset() {
    let mut c = case(2, 300);
    c.asset = OTHER_ASSET;
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn inflated_amount() {
    let mut c = case(2, 300);
    c.notes[0].amount = 1000;
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn wrong_root() {
    let mut c = case(2, 300);
    c.root = c.root + 1;
    run(c);
}

#[test(should_fail_with = "verifier nonce required")]
fn zero_nonce() {
    let mut c = case(2, 300);
    c.nonce = 0;
    run(c);
}

#[test(should_fail)]
fn threshold_must_fit_128_bits() {
    run(case(4, TWO_POW_128));
}
