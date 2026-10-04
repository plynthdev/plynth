// Hidden Vault swap: spend one note of `asset_in`, hand `amount_in` to ShieldedTrade for a private sell, buy,
// park or unpark, keep the rest as a v1 change note, and fix the output note except for its amount.
//
// Public: root, nullifier, change_commitment, asset_in, amount_in, relayer_fee, asset_out, min_out,
//         out_partial, deadline.
//
// The output amount is only known after the on-chain swap, so the proof commits to
//   out_partial = H(asset_out, out_owner_pk, out_blinding)
// and ShieldedTrade inserts commitment = H(out_partial, actual_out) after checking actual_out >= min_out
// (a v2 note, see hidden/src/lib.nr). Every public input is bound by the proof, so a relayer cannot change
// the output asset, owner, minimum, deadline or fee. The input note may be v1 or v2 (a previous swap's output
// can be swapped again without settling it first).

use hidden::{commitment, commitment_any, merkle_root, nullifier, owner_pk, partial_commitment, TREE_DEPTH};

fn main(
    root: pub Field,
    nullifier_hash: pub Field,
    change_commitment: pub Field,
    asset_in: pub Field,
    amount_in: pub Field,
    relayer_fee: pub Field,
    asset_out: pub Field,
    min_out: pub Field,
    out_partial: pub Field,
    deadline: pub Field,
    in_is_v2: bool,
    in_amount: Field,
    in_secret: Field,
    in_blinding: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
    change_amount: Field,
    change_owner_pk: Field,
    change_blinding: Field,
    out_owner_pk: Field,
    out_blinding: Field,
) {
    asset_in.assert_max_bit_size::<160>();
    asset_out.assert_max_bit_size::<160>();
    assert(asset_in != asset_out, "same asset");
    in_amount.assert_max_bit_size::<128>();
    amount_in.assert_max_bit_size::<128>();
    change_amount.assert_max_bit_size::<128>();
    relayer_fee.assert_max_bit_size::<128>();
    min_out.assert_max_bit_size::<128>();
    deadline.assert_max_bit_size::<64>();

    let c = commitment_any(in_is_v2, asset_in, in_amount, owner_pk(in_secret), in_blinding);
    assert(merkle_root(c, in_index, in_path) == root, "input note not in tree");
    assert(nullifier(c, in_secret, in_index) == nullifier_hash, "bad nullifier");

    let change = commitment(asset_in, change_amount, change_owner_pk, change_blinding);
    assert(change == change_commitment, "bad change commitment");

    // All terms < 2^128, so no field wrap.
    assert(in_amount == amount_in + change_amount, "value not conserved");
    // relayer_fee <= amount_in (both < 2^128) and something is left to swap.
    let net = amount_in - relayer_fee;
    net.assert_max_bit_size::<128>();
    assert(net != 0, "nothing to swap");

    assert(partial_commitment(asset_out, out_owner_pk, out_blinding) == out_partial, "bad output note");
}

// ---------------------------------------------------------------- tests

global STOCK: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global USDG: Field = 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512;
global TWO_POW_128: Field = 340282366920938463463374607431768211456;
global SECRET: Field = 101;
global DEADLINE: Field = 1800000000;

struct Case {
    root: Field,
    nullifier_hash: Field,
    change_commitment: Field,
    asset_in: Field,
    amount_in: Field,
    relayer_fee: Field,
    asset_out: Field,
    min_out: Field,
    out_partial: Field,
    deadline: Field,
    in_is_v2: bool,
    in_amount: Field,
    in_secret: Field,
    in_index: Field,
    in_path: [Field; TREE_DEPTH],
    change_amount: Field,
    out_owner_pk: Field,
    out_blinding: Field,
}

// The spent note sits at leaf 1 (leaf 0 is someone else's note).
fn case_v(is_v2: bool, in_amount: Field, amount_in: Field, change_amount: Field, relayer_fee: Field) -> Case {
    let mine = commitment_any(is_v2, STOCK, in_amount, owner_pk(SECRET), 7);
    let other = commitment(STOCK, 5, owner_pk(55), 3);
    let (root, paths) = hidden::small_tree([other, mine]);
    Case {
        root,
        nullifier_hash: nullifier(mine, SECRET, 1),
        change_commitment: commitment(STOCK, change_amount, owner_pk(SECRET), 8),
        asset_in: STOCK,
        amount_in,
        relayer_fee,
        asset_out: USDG,
        min_out: 990,
        out_partial: partial_commitment(USDG, owner_pk(SECRET), 9),
        deadline: DEADLINE,
        in_is_v2: is_v2,
        in_amount,
        in_secret: SECRET,
        in_index: 1,
        in_path: paths[1],
        change_amount,
        out_owner_pk: owner_pk(SECRET),
        out_blinding: 9,
    }
}

fn case(in_amount: Field, amount_in: Field, change_amount: Field, relayer_fee: Field) -> Case {
    case_v(false, in_amount, amount_in, change_amount, relayer_fee)
}

fn run(c: Case) {
    main(
        c.root,
        c.nullifier_hash,
        c.change_commitment,
        c.asset_in,
        c.amount_in,
        c.relayer_fee,
        c.asset_out,
        c.min_out,
        c.out_partial,
        c.deadline,
        c.in_is_v2,
        c.in_amount,
        c.in_secret,
        7,
        c.in_index,
        c.in_path,
        c.change_amount,
        owner_pk(SECRET),
        8,
        c.out_owner_pk,
        c.out_blinding,
    );
}

#[test]
fn valid_partial_sell() {
    run(case(1000, 600, 400, 10));
}

#[test]
fn valid_full_sell_zero_change() {
    run(case(1000, 1000, 0, 0));
}

#[test]
fn valid_spend_of_a_v2_note() {
    run(case_v(true, 1000, 1000, 0, 0));
}

#[test]
fn output_may_belong_to_someone_else() {
    let mut c = case(1000, 600, 400, 0);
    c.out_owner_pk = owner_pk(77);
    c.out_partial = partial_commitment(USDG, owner_pk(77), 9);
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn version_flag_must_match_the_note() {
    let mut c = case_v(true, 1000, 600, 400, 0);
    c.in_is_v2 = false;
    run(c);
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
fn foreign_owner_cannot_spend() {
    let mut c = case(1000, 600, 400, 0);
    c.in_secret = 999;
    run(c);
}

#[test(should_fail_with = "input note not in tree")]
fn asset_in_must_be_the_note_asset() {
    let mut c = case(1000, 600, 400, 0);
    c.asset_in = USDG;
    c.asset_out = STOCK;
    c.out_partial = partial_commitment(STOCK, owner_pk(SECRET), 9);
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn nullifier_of_other_leaf() {
    let mut c = case(1000, 600, 400, 0);
    c.nullifier_hash = nullifier(commitment(STOCK, 1000, owner_pk(SECRET), 7), SECRET, 0);
    run(c);
}

#[test(should_fail_with = "bad change commitment")]
fn change_must_match() {
    let mut c = case(1000, 600, 400, 0);
    c.change_commitment = c.change_commitment + 1;
    run(c);
}

#[test(should_fail_with = "bad output note")]
fn output_asset_is_bound() {
    // A partial note made for another asset cannot be filled as `asset_out`.
    let mut c = case(1000, 600, 400, 0);
    c.out_partial = partial_commitment(STOCK + 1, owner_pk(SECRET), 9);
    run(c);
}

#[test(should_fail_with = "bad output note")]
fn output_owner_is_bound() {
    let mut c = case(1000, 600, 400, 0);
    c.out_owner_pk = owner_pk(77);
    run(c);
}

#[test(should_fail_with = "same asset")]
fn same_asset_rejected() {
    let mut c = case(1000, 600, 400, 0);
    c.asset_out = STOCK;
    c.out_partial = partial_commitment(STOCK, owner_pk(SECRET), 9);
    run(c);
}

#[test(should_fail_with = "nothing to swap")]
fn fee_equal_to_amount_leaves_nothing() {
    run(case(1000, 600, 400, 600));
}

#[test(should_fail_with = "nothing to swap")]
fn zero_amount_rejected() {
    run(case(1000, 0, 1000, 0));
}

#[test(should_fail)]
fn relayer_fee_above_amount() {
    run(case(1000, 600, 400, 601));
}

#[test(should_fail)]
fn amount_overflow() {
    run(case(1000, TWO_POW_128, 1000 - TWO_POW_128, 0));
}

#[test(should_fail)]
fn min_out_must_fit_128_bits() {
    let mut c = case(1000, 600, 400, 0);
    c.min_out = TWO_POW_128;
    run(c);
}

#[test(should_fail)]
fn deadline_must_fit_64_bits() {
    let mut c = case(1000, 600, 400, 0);
    c.deadline = 18446744073709551616;
    run(c);
}

#[test(should_fail)]
fn asset_out_must_fit_160_bits() {
    let mut c = case(1000, 600, 400, 0);
    c.asset_out = TWO_POW_128 * TWO_POW_128;
    c.out_partial = partial_commitment(c.asset_out, owner_pk(SECRET), 9);
    run(c);
}
