// Hidden Vault settle: turn one v2 note (a swap output, see swap/ and hidden/src/lib.nr) into a v1 note of the
// same asset and amount, so transfer/withdraw (and threshold proofs) can use it. Nothing leaves the pool and
// nothing about the note is public except its nullifier and the new commitment.
//
// Public: root, nullifier, out_commitment, ext_hash.
//
// ext_hash (public) = keccak256 of the encrypted note(s) this spend publishes, mod p (the pool recomputes it from
// calldata). It is not used in any constraint: being a public input binds it to the proof, so whoever submits
// the proof (a relayer) cannot swap the ciphertext that carries the only copy of a new note's blinding.
// ext_hash = keccak256(encryptedOut) mod p.

use hidden::{commitment, commitment_v2, merkle_root, nullifier, owner_pk, partial_commitment, TREE_DEPTH};

fn main(
    root: pub Field,
    nullifier_hash: pub Field,
    out_commitment: pub Field,
    ext_hash: pub Field,
    asset_id: Field,
    amount: Field,
    in_secret: Field,
    in_blinding: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
    out_owner_pk: Field,
    out_blinding: Field,
) {
    asset_id.assert_max_bit_size::<160>();
    amount.assert_max_bit_size::<128>();
    let c = commitment_v2(partial_commitment(asset_id, owner_pk(in_secret), in_blinding), amount);
    assert(merkle_root(c, in_index, in_path) == root, "input note not in tree");
    assert(nullifier(c, in_secret, in_index) == nullifier_hash, "bad nullifier");
    assert(commitment(asset_id, amount, out_owner_pk, out_blinding) == out_commitment, "bad output note");
}

// ---------------------------------------------------------------- tests

global ASSET: Field = 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512;
global SECRET: Field = 101;

struct Case {
    root: Field,
    nullifier_hash: Field,
    out_commitment: Field,
    asset_id: Field,
    amount: Field,
    in_secret: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
}

fn case(amount: Field) -> Case {
    let mine = commitment_v2(partial_commitment(ASSET, owner_pk(SECRET), 7), amount);
    let v1_twin = commitment(ASSET, amount, owner_pk(SECRET), 7);
    let (root, paths) = hidden::small_tree([v1_twin, mine]);
    Case {
        root,
        nullifier_hash: nullifier(mine, SECRET, 1),
        out_commitment: commitment(ASSET, amount, owner_pk(SECRET), 8),
        asset_id: ASSET,
        amount,
        in_secret: SECRET,
        in_index: 1,
        in_path: paths[1],
    }
}

fn run(c: Case) {
    main(
        c.root,
        c.nullifier_hash,
        c.out_commitment,
        0x1234,
        c.asset_id,
        c.amount,
        c.in_secret,
        7,
        c.in_index,
        c.in_path,
        owner_pk(SECRET),
        8,
    );
}

#[test]
fn valid_settle() {
    run(case(1234));
}

#[test(should_fail_with = "bad output note")]
fn amount_cannot_grow() {
    let mut c = case(1234);
    c.out_commitment = commitment(ASSET, 1235, owner_pk(SECRET), 8);
    run(c);
}

#[test(should_fail_with = "bad output note")]
fn asset_cannot_change() {
    let mut c = case(1234);
    c.out_commitment = commitment(ASSET + 1, 1234, owner_pk(SECRET), 8);
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn v1_note_cannot_be_settled() {
    // Leaf 0 is the v1 note with the same fields; settle only opens v2 commitments.
    let mut c = case(1234);
    c.in_index = 0;
    c.nullifier_hash = nullifier(commitment(ASSET, 1234, owner_pk(SECRET), 7), SECRET, 0);
    let (_, paths) = hidden::small_tree([
        commitment(ASSET, 1234, owner_pk(SECRET), 7),
        commitment_v2(partial_commitment(ASSET, owner_pk(SECRET), 7), 1234),
    ]);
    c.in_path = paths[0];
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn foreign_owner_cannot_settle() {
    let mut c = case(1234);
    c.in_secret = 999;
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn nullifier_must_match() {
    let mut c = case(1234);
    c.nullifier_hash = c.nullifier_hash + 1;
    run(c);
}
