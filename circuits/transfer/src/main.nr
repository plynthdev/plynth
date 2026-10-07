// Hidden Vault 2-in/2-out shielded transfer of a single asset.
//
// Public: root, nullifiers[2], out_commitments[2], asset_id, ext_hash.
// Proves: each non-dummy input note is in the tree under `root` and is owned by the prover,
// each nullifier is that note's nullifier, the two nullifiers differ, every amount < 2^128,
// asset_id < 2^160, and sum(in) == sum(out). An input with amount 0 is a dummy: membership is
// skipped (so 1-in transfers work) but its nullifier is still bound, so the pool spends it. At least one input
// must be real (sum(in) != 0): two dummies would let anyone append leaves without owning a note. A zero-value
// output's commitment is 0 and the pool inserts no leaf for it.
//
// ext_hash (public) = keccak256 of the encrypted note(s) this spend publishes, mod p (the pool recomputes it from
// calldata). It is not used in any constraint: being a public input binds it to the proof, so whoever submits
// the proof (a relayer) cannot swap the ciphertext that carries the only copy of a new note's blinding.
// ext_hash = keccak256(abi.encode(encryptedNotes[0], encryptedNotes[1])) mod p.

use hidden::{commitment, commitment_or_zero, merkle_root, nullifier, owner_pk, TREE_DEPTH};

pub struct InputNote {
    amount: Field,
    secret: Field,
    blinding: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

pub struct OutputNote {
    amount: Field,
    owner_pk: Field,
    blinding: Field,
}

fn main(
    root: pub Field,
    nullifiers: pub [Field; 2],
    out_commitments: pub [Field; 2],
    asset_id: pub Field,
    ext_hash: pub Field,
    inputs: [InputNote; 2],
    outputs: [OutputNote; 2],
) {
    asset_id.assert_max_bit_size::<160>();

    let mut total_in: Field = 0;
    for i in 0..2 {
        let note = inputs[i];
        note.amount.assert_max_bit_size::<128>();
        let c = commitment(asset_id, note.amount, owner_pk(note.secret), note.blinding);
        let computed_root = merkle_root(c, note.index, note.path);
        if note.amount != 0 {
            assert(computed_root == root, "input note not in tree");
        }
        assert(nullifier(c, note.secret, note.index) == nullifiers[i], "bad nullifier");
        total_in += note.amount;
    }
    assert(nullifiers[0] != nullifiers[1], "input notes must differ");
    // Both amounts < 2^128: the sum cannot wrap to 0.
    assert(total_in != 0, "no real input");

    let mut total_out: Field = 0;
    for i in 0..2 {
        let note = outputs[i];
        note.amount.assert_max_bit_size::<128>();
        let c = commitment_or_zero(asset_id, note.amount, note.owner_pk, note.blinding);
        assert(c == out_commitments[i], "bad output commitment");
        total_out += note.amount;
    }
    // Every amount is < 2^128, so both sums are < 2^129 and cannot wrap the field.
    assert(total_in == total_out, "value not conserved");
}

// ---------------------------------------------------------------- tests

global ASSET: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global TWO_POW_128: Field = 340282366920938463463374607431768211456;

struct Case {
    root: Field,
    nullifiers: [Field; 2],
    out_commitments: [Field; 2],
    inputs: [InputNote; 2],
    outputs: [OutputNote; 2],
}

// Two notes (secrets 101/102) at leaves 0 and 1 of an otherwise empty tree.
fn case(in_amounts: [Field; 2], out_amounts: [Field; 2]) -> Case {
    let secrets = [101, 102];
    let blindings = [7, 8];
    let leaves = [
        commitment(ASSET, in_amounts[0], owner_pk(secrets[0]), blindings[0]),
        commitment(ASSET, in_amounts[1], owner_pk(secrets[1]), blindings[1]),
    ];
    let (root, paths) = hidden::small_tree(leaves);
    let inputs = [
        InputNote { amount: in_amounts[0], secret: secrets[0], blinding: blindings[0], index: 0, path: paths[0] },
        InputNote { amount: in_amounts[1], secret: secrets[1], blinding: blindings[1], index: 1, path: paths[1] },
    ];
    let outputs = [
        OutputNote { amount: out_amounts[0], owner_pk: owner_pk(201), blinding: 9 },
        OutputNote { amount: out_amounts[1], owner_pk: owner_pk(202), blinding: 10 },
    ];
    Case {
        root,
        nullifiers: [nullifier(leaves[0], secrets[0], 0), nullifier(leaves[1], secrets[1], 1)],
        out_commitments: [
            hidden::commitment_or_zero(ASSET, out_amounts[0], outputs[0].owner_pk, 9),
            hidden::commitment_or_zero(ASSET, out_amounts[1], outputs[1].owner_pk, 10),
        ],
        inputs,
        outputs,
    }
}

fn run(c: Case) {
    main(c.root, c.nullifiers, c.out_commitments, ASSET, 0x1234, c.inputs, c.outputs);
}

#[test]
fn valid_two_in_two_out() {
    run(case([1000, 250], [600, 650]));
}

#[test]
fn valid_one_in_with_dummy() {
    // Second input is a dummy (amount 0) whose path is garbage: membership is skipped.
    let mut c = case([1000, 0], [1000, 0]);
    c.inputs[1].path = [0; TREE_DEPTH];
    run(c);
}

#[test(should_fail_with = "no real input")]
fn two_dummy_inputs_rejected() {
    // Anyone could otherwise append leaves for free: two zero-value dummies with garbage paths.
    let mut c = case([0, 0], [0, 0]);
    c.inputs[0].path = [0; TREE_DEPTH];
    c.inputs[1].path = [0; TREE_DEPTH];
    run(c);
}

#[test(should_fail_with = "bad output commitment")]
fn zero_output_must_use_the_zero_sentinel() {
    let mut c = case([1000, 0], [1000, 0]);
    c.inputs[1].path = [0; TREE_DEPTH];
    c.out_commitments[1] = commitment(ASSET, 0, c.outputs[1].owner_pk, 10);
    run(c);
}

#[test]
fn valid_max_amount() {
    run(case([TWO_POW_128 - 1, 0], [TWO_POW_128 - 2, 1]));
}

#[test(should_fail_with = "value not conserved")]
fn inflation_out_exceeds_in() {
    run(case([1000, 250], [1000, 251]));
}

#[test(should_fail_with = "input note not in tree")]
fn wrong_root() {
    let mut c = case([1000, 250], [600, 650]);
    c.root = c.root + 1;
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn foreign_owner_cannot_spend() {
    // Right commitment and path but the prover does not know the secret.
    let mut c = case([1000, 250], [600, 650]);
    c.inputs[0].secret = 999;
    run(c);
}

#[test(should_fail_with = "input notes must differ")]
fn reused_nullifier_inputs() {
    // The same note supplied twice: both nullifiers are equal.
    let mut c = case([1000, 250], [1000, 1000]);
    c.inputs[1] = c.inputs[0];
    c.nullifiers[1] = c.nullifiers[0];
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn nullifier_must_match_note() {
    let mut c = case([1000, 250], [600, 650]);
    c.nullifiers[0] = c.nullifiers[0] + 1;
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn dummy_nullifier_still_bound() {
    let mut c = case([1000, 0], [1000, 0]);
    c.nullifiers[1] = 12345;
    run(c);
}

#[test(should_fail_with = "bad output commitment")]
fn output_commitment_bound() {
    let mut c = case([1000, 250], [600, 650]);
    c.outputs[0].owner_pk = owner_pk(666);
    run(c);
}

#[test(should_fail)]
fn amount_overflow_output() {
    // out[0] = 2^128 overflows; out[1] = p - 2^128 + 1250 would make the field sum balance.
    let c = case([1000, 250], [TWO_POW_128, 1250 - TWO_POW_128]);
    run(c);
}

#[test(should_fail)]
fn amount_overflow_input() {
    run(case([TWO_POW_128, 0], [TWO_POW_128, 0]));
}

#[test(should_fail)]
fn asset_id_must_fit_160_bits() {
    let c = case([1000, 250], [600, 650]);
    main(c.root, c.nullifiers, c.out_commitments, TWO_POW_128 * TWO_POW_128, 0x1234, c.inputs, c.outputs);
}
