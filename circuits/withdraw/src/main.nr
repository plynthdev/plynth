// Hidden Vault withdraw: spend one note, pay `amount` publicly, keep the rest as a change note.
//
// Public: root, nullifier, change_commitment, asset_id, amount, recipient, relayer_fee, ext_hash.
// `recipient` and `relayer_fee` are public inputs of the proof, so a relayer that changes
// either one invalidates it and cannot redirect the funds. The pool pays
// `amount - relayer_fee` to `recipient` and `relayer_fee` to the relayer.
//
// ext_hash (public) = keccak256 of the encrypted note(s) this spend publishes, mod p (the pool recomputes it from
// calldata). It is not used in any constraint: being a public input binds it to the proof, so whoever submits
// the proof (a relayer) cannot swap the ciphertext that carries the only copy of a new note's blinding.
// ext_hash = keccak256(encryptedChange) mod p.

use hidden::{commitment, merkle_root, nullifier, owner_pk, TREE_DEPTH};

fn main(
    root: pub Field,
    nullifier_hash: pub Field,
    change_commitment: pub Field,
    asset_id: pub Field,
    amount: pub Field,
    recipient: pub Field,
    relayer_fee: pub Field,
    ext_hash: pub Field,
    in_amount: Field,
    in_secret: Field,
    in_blinding: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
    change_amount: Field,
    change_owner_pk: Field,
    change_blinding: Field,
) {
    asset_id.assert_max_bit_size::<160>();
    recipient.assert_max_bit_size::<160>();
    in_amount.assert_max_bit_size::<128>();
    amount.assert_max_bit_size::<128>();
    change_amount.assert_max_bit_size::<128>();
    relayer_fee.assert_max_bit_size::<128>();

    let c = commitment(asset_id, in_amount, owner_pk(in_secret), in_blinding);
    assert(merkle_root(c, in_index, in_path) == root, "input note not in tree");
    assert(nullifier(c, in_secret, in_index) == nullifier_hash, "bad nullifier");

    let change = commitment(asset_id, change_amount, change_owner_pk, change_blinding);
    assert(change == change_commitment, "bad change commitment");

    // All terms < 2^128, so no field wrap.
    assert(in_amount == amount + change_amount, "value not conserved");
    // relayer_fee <= amount, both < 2^128.
    (amount - relayer_fee).assert_max_bit_size::<128>();
}

// ---------------------------------------------------------------- tests

global ASSET: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global RECIPIENT: Field = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8;
global TWO_POW_128: Field = 340282366920938463463374607431768211456;
global SECRET: Field = 101;

struct Case {
    root: Field,
    nullifier_hash: Field,
    change_commitment: Field,
    amount: Field,
    recipient: Field,
    relayer_fee: Field,
    in_amount: Field,
    in_secret: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
    change_amount: Field,
}

// The spent note sits at leaf 1 (leaf 0 is someone else's note).
fn case(in_amount: Field, amount: Field, change_amount: Field, relayer_fee: Field) -> Case {
    let mine = commitment(ASSET, in_amount, owner_pk(SECRET), 7);
    let other = commitment(ASSET, 5, owner_pk(55), 3);
    let (root, paths) = hidden::small_tree([other, mine]);
    Case {
        root,
        nullifier_hash: nullifier(mine, SECRET, 1),
        change_commitment: commitment(ASSET, change_amount, owner_pk(SECRET), 8),
        amount,
        recipient: RECIPIENT,
        relayer_fee,
        in_amount,
        in_secret: SECRET,
        in_index: 1,
        in_path: paths[1],
        change_amount,
    }
}

fn run(c: Case) {
    main(
        c.root,
        c.nullifier_hash,
        c.change_commitment,
        ASSET,
        c.amount,
        c.recipient,
        c.relayer_fee,
        0x1234,
        c.in_amount,
        c.in_secret,
        7,
        c.in_index,
        c.in_path,
        c.change_amount,
        owner_pk(SECRET),
        8,
    );
}

#[test]
fn valid_partial_withdraw() {
    run(case(1000, 600, 400, 10));
}

#[test]
fn valid_full_withdraw_zero_change() {
    run(case(1000, 1000, 0, 0));
}

#[test]
fn valid_fee_equals_amount() {
    run(case(1000, 10, 990, 10));
}

#[test(should_fail_with = "value not conserved")]
fn inflation_amount_exceeds_note() {
    run(case(1000, 1001, 0, 0));
}

#[test(should_fail_with = "value not conserved")]
fn inflation_change_exceeds_remainder() {
    run(case(1000, 600, 401, 0));
}

#[test(should_fail_with = "input note not in tree")]
fn wrong_root() {
    let mut c = case(1000, 600, 400, 0);
    c.root = c.root + 1;
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn wrong_index() {
    let mut c = case(1000, 600, 400, 0);
    c.in_index = 0;
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn foreign_owner_cannot_spend() {
    let mut c = case(1000, 600, 400, 0);
    c.in_secret = 999;
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn reused_nullifier_of_other_leaf() {
    // Submitting a nullifier computed for a different leaf index (i.e. a nullifier that is not
    // this note's) is rejected, so one note cannot produce two different nullifiers.
    let mut c = case(1000, 600, 400, 0);
    c.nullifier_hash = nullifier(commitment(ASSET, 1000, owner_pk(SECRET), 7), SECRET, 0);
    run(c);
}

#[test(should_fail)]
fn relayer_fee_above_amount() {
    run(case(1000, 600, 400, 601));
}

#[test(should_fail)]
fn amount_overflow() {
    // amount = 2^128 with change = in - 2^128 (wraps) would balance in the field.
    run(case(1000, TWO_POW_128, 1000 - TWO_POW_128, 0));
}

#[test(should_fail)]
fn recipient_must_fit_160_bits() {
    let mut c = case(1000, 600, 400, 0);
    c.recipient = TWO_POW_128 * TWO_POW_128;
    run(c);
}
