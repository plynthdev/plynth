// Treasury period close with a private sleeve: "the treasury's unspent notes at `root`, valued at the pinned
// prices, are worth at least `nav_bound`, and with them the book's band weights are inside the policy bands",
// without revealing which notes, which assets, how much of each, or the exact private value.
//
// Public:
//   root               any root ShieldedPool has published (PrivateSleeve checks rootSeq != 0)
//   owner_pk           the sleeve's owner key (H(spending secret)); every counted note must belong to it
//   policy_hash        TreasuryPolicy hash (mod p) of the version in force at the period end (binds the bands)
//   prices_commitment  acc_{k+1} = H(acc_k, H(asset_k, price_k, multiplier_k, round_k)), acc_0 = 0, over the
//                      sleeve's MAX_ASSETS asset slots (unused slots are all zero). price_k is USD (1e18) per
//                      whole token with the multiplier already applied (Valuer), so value = raw * price / 1e18;
//                      the multiplier and Chainlink round are committed so the bundle can show them.
//   nav_bound          claimed private NAV (USD 1e18): sum(raw * price) >= nav_bound * 1e18
//   pub_nav            public NAV (USD 1e18), recomputed on-chain
//   pub_band_usd[3]    public cash / equity / basis USD (1e18), recomputed on-chain
//   band_min/max[3]    policy bands in bps (cash, equity, basis)
//   private_band       the band the private sleeve counts toward (0, 1 or 2)
//   nullifier_hashes   each real slot's nullifier (PrivateSleeve checks none is spent); padding slots output 0
//
// Band rule, on the exact private value S = sum(raw * price) (scaled by 1e18):
//   total = pub_nav * 1e18 + S;  w_b = (pub_band_usd[b] * 1e18 + [b == private_band] * S) / total
//   band_min[b] <= w_b * 10_000 <= band_max[b]  for every band (no division: cross-multiplied).
//
// Reuses the threshold_holdings gadgets (commitment, Merkle opening, in-circuit nullifier, duplicate check,
// wrap-around comparison). Bounds keep every product below p: amounts < 2^128, prices < 2^96 (so
// S < 8 * 2^224 = 2^227), public USD < 2^128, bps < 2^16.

use hidden::{commitment_any, hash, merkle_root, nullifier, owner_pk, TREE_DEPTH};

pub global MAX_NOTES: u32 = 8;
pub global MAX_ASSETS: u32 = 4;
global WAD: Field = 1000000000000000000;
global BPS: Field = 10000;
global TWO_POW_228: Field = 431359146674410236714672241392314090778194310760649159697657763987456;

pub struct Slot {
    is_real: bool,
    is_v2: bool,
    asset_slot: u32,
    amount: Field,
    blinding: Field,
    index: Field,
    path: [Field; TREE_DEPTH],
}

pub fn prices_commitment_of(
    assets: [Field; MAX_ASSETS],
    prices: [Field; MAX_ASSETS],
    multipliers: [Field; MAX_ASSETS],
    round_ids: [Field; MAX_ASSETS],
) -> Field {
    let mut acc: Field = 0;
    for k in 0..MAX_ASSETS {
        acc = hash([acc, hash([assets[k], prices[k], multipliers[k], round_ids[k]])]);
    }
    acc
}

fn main(
    root: pub Field,
    owner_pk_pub: pub Field,
    policy_hash: pub Field,
    prices_commitment: pub Field,
    nav_bound: pub Field,
    pub_nav: pub Field,
    pub_band_usd: pub [Field; 3],
    band_min_bps: pub [Field; 3],
    band_max_bps: pub [Field; 3],
    private_band: pub Field,
    nullifier_hashes: pub [Field; MAX_NOTES],
    secret: Field,
    assets: [Field; MAX_ASSETS],
    prices: [Field; MAX_ASSETS],
    multipliers: [Field; MAX_ASSETS],
    round_ids: [Field; MAX_ASSETS],
    notes: [Slot; MAX_NOTES],
) {
    assert(policy_hash != 0, "policy hash required");
    nav_bound.assert_max_bit_size::<128>();
    pub_nav.assert_max_bit_size::<128>();
    assert(private_band * (private_band - 1) * (private_band - 2) == 0, "bad band");
    for b in 0..3 {
        pub_band_usd[b].assert_max_bit_size::<128>();
        band_min_bps[b].assert_max_bit_size::<16>();
        band_max_bps[b].assert_max_bit_size::<16>();
    }
    for k in 0..MAX_ASSETS {
        prices[k].assert_max_bit_size::<96>();
    }
    assert(prices_commitment_of(assets, prices, multipliers, round_ids) == prices_commitment, "prices not pinned");
    assert(owner_pk(secret) == owner_pk_pub, "not the sleeve's key");

    let mut sum: Field = 0;
    for i in 0..MAX_NOTES {
        let n = notes[i];
        if n.is_real {
            n.amount.assert_max_bit_size::<128>();
            let asset = assets[n.asset_slot];
            assert(asset != 0, "empty asset slot");
            let c = commitment_any(n.is_v2, asset, n.amount, owner_pk_pub, n.blinding);
            assert(merkle_root(c, n.index, n.path) == root, "note not in tree");
            assert(nullifier(c, secret, n.index) == nullifier_hashes[i], "bad nullifier");
            for j in 0..i {
                if notes[j].is_real {
                    assert(notes[j].index != n.index, "note counted twice");
                }
            }
            sum += n.amount * prices[n.asset_slot];
        } else {
            assert(nullifier_hashes[i] == 0, "padding slot must output a zero nullifier");
        }
    }

    // (a) solvency: sum >= nav_bound * 1e18 (sum < 2^227, nav_bound * 1e18 < 2^188: the difference stays below
    // 2^228 exactly when it does not wrap).
    assert((sum - nav_bound * WAD).lt(TWO_POW_228), "private NAV below claim");

    // (b) policy bands with the exact private value.
    let total = pub_nav * WAD + sum;
    for b in 0..3 {
        let mut v = pub_band_usd[b] * WAD;
        if private_band == b as Field {
            v += sum;
        }
        let scaled = v * BPS;
        assert(!scaled.lt(band_min_bps[b] * total), "band below min");
        assert(!(band_max_bps[b] * total).lt(scaled), "band above max");
    }
}

// ---------------------------------------------------------------- tests

global A: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
global B: Field = 0x0000000000000000000000000000000000000b0b;
global SECRET: Field = 4242;
global E18: Field = 1000000000000000000;

struct Case {
    root: Field,
    pk: Field,
    policy_hash: Field,
    prices_commitment: Field,
    nav_bound: Field,
    pub_nav: Field,
    pub_band_usd: [Field; 3],
    band_min: [Field; 3],
    band_max: [Field; 3],
    private_band: Field,
    nullifiers: [Field; MAX_NOTES],
    secret: Field,
    assets: [Field; MAX_ASSETS],
    prices: [Field; MAX_ASSETS],
    multipliers: [Field; MAX_ASSETS],
    round_ids: [Field; MAX_ASSETS],
    notes: [Slot; MAX_NOTES],
}

fn pad() -> Slot {
    Slot { is_real: false, is_v2: false, asset_slot: 0, amount: 0, blinding: 0, index: 0, path: [0; TREE_DEPTH] }
}

// Book: public USDG 600k + equity 330k (pub_nav 930k); private notes A 250 + A 200 (@ $200) and B 300 (@ $100)
// = $120k. Total $1.05M: cash 57.1% (band 40-70%), equity 42.9% (30-60%), basis 0 (0-0).
// Tree: leaf 0 = someone else's A note, leaves 1..3 = the sleeve's notes.
fn case() -> Case {
    let pk = owner_pk(SECRET);
    let assets = [A, B, 0, 0];
    let prices = [200 * E18, 100 * E18, 0, 0];
    let multipliers = [E18, 1001 * E18 / 1000, 0, 0];
    let round_ids = [7, 9, 0, 0];
    let amounts = [250 * E18, 200 * E18, 300 * E18];
    let slots = [0, 0, 1];
    let mine = [
        commitment_any(false, A, amounts[0], pk, 21),
        commitment_any(false, A, amounts[1], pk, 22),
        commitment_any(false, B, amounts[2], pk, 23),
    ];
    let (root, paths) = hidden::small_tree([commitment_any(false, A, 5000 * E18, owner_pk(77), 3), mine[0], mine[1], mine[2]]);
    let mut notes = [pad(); MAX_NOTES];
    let mut nullifiers = [0; MAX_NOTES];
    for k in 0..3 {
        notes[k] = Slot {
            is_real: true,
            is_v2: false,
            asset_slot: slots[k],
            amount: amounts[k],
            blinding: 21 + k as Field,
            index: k as Field + 1,
            path: paths[k + 1],
        };
        nullifiers[k] = nullifier(mine[k], SECRET, k as Field + 1);
    }
    Case {
        root,
        pk,
        policy_hash: 0xabcdef,
        prices_commitment: prices_commitment_of(assets, prices, multipliers, round_ids),
        nav_bound: 120000 * E18,
        pub_nav: 930000 * E18,
        pub_band_usd: [600000 * E18, 330000 * E18, 0],
        band_min: [4000, 3000, 0],
        band_max: [7000, 6000, 0],
        private_band: 1,
        nullifiers,
        secret: SECRET,
        assets,
        prices,
        multipliers,
        round_ids,
        notes,
    }
}

fn run(c: Case) {
    main(
        c.root,
        c.pk,
        c.policy_hash,
        c.prices_commitment,
        c.nav_bound,
        c.pub_nav,
        c.pub_band_usd,
        c.band_min,
        c.band_max,
        c.private_band,
        c.nullifiers,
        c.secret,
        c.assets,
        c.prices,
        c.multipliers,
        c.round_ids,
        c.notes,
    );
}

#[test]
fn true_book_exact_nav() {
    run(case());
}

#[test]
fn lower_nav_bound_is_fine() {
    let mut c = case();
    c.nav_bound = 100000 * E18;
    run(c);
}

#[test]
fn empty_sleeve_proves_zero() {
    let mut c = case();
    c.notes = [pad(); MAX_NOTES];
    c.nullifiers = [0; MAX_NOTES];
    c.nav_bound = 0;
    run(c);
}

#[test]
fn padding_in_the_middle() {
    let mut c = case();
    c.notes[1] = pad();
    c.nullifiers[1] = 0;
    c.nav_bound = 80000 * E18; // A 250 + B 300
    run(c);
}

#[test]
fn v2_note_counts() {
    let mut c = case();
    let pk = owner_pk(SECRET);
    let v2 = commitment_any(true, B, 50 * E18, pk, 99);
    let (root, paths) = hidden::small_tree([v2]);
    c.root = root;
    c.notes = [pad(); MAX_NOTES];
    c.nullifiers = [0; MAX_NOTES];
    c.notes[0] = Slot { is_real: true, is_v2: true, asset_slot: 1, amount: 50 * E18, blinding: 99, index: 0, path: paths[0] };
    c.nullifiers[0] = nullifier(v2, SECRET, 0);
    c.nav_bound = 5000 * E18;
    c.pub_band_usd = [600000 * E18, 400000 * E18, 0]; // 1.005M: cash 59.7%, equity 40.3%
    c.pub_nav = 1000000 * E18;
    run(c);
}

#[test(should_fail_with = "private NAV below claim")]
fn inflated_nav_fails() {
    let mut c = case();
    c.nav_bound = 120000 * E18 + 1;
    run(c);
}

#[test(should_fail_with = "private NAV below claim")]
fn dropped_note_cannot_reach_full_nav() {
    let mut c = case();
    c.notes[2] = pad();
    c.nullifiers[2] = 0;
    run(c);
}

#[test(should_fail_with = "band above max")]
fn equity_band_breach_fails() {
    let mut c = case();
    c.band_max = [7000, 4000, 0]; // equity is 42.9%
    run(c);
}

#[test(should_fail_with = "band below min")]
fn cash_band_breach_fails() {
    let mut c = case();
    c.band_min = [6000, 3000, 0]; // cash is 57.1%
    run(c);
}

#[test(should_fail_with = "band above max")]
fn private_value_counts_in_its_band() {
    // Same book, private sleeve declared as basis: basis weight 11.4% breaks the 0-0 basis band.
    let mut c = case();
    c.private_band = 2;
    run(c);
}

#[test(should_fail_with = "prices not pinned")]
fn price_not_in_commitment_fails() {
    let mut c = case();
    c.prices[0] = 210 * E18;
    run(c);
}

#[test(should_fail_with = "prices not pinned")]
fn multiplier_is_committed() {
    let mut c = case();
    c.multipliers[1] = E18;
    run(c);
}

#[test(should_fail_with = "not the sleeve's key")]
fn foreign_secret_fails() {
    let mut c = case();
    c.secret = 999;
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn foreign_notes_cannot_be_counted() {
    // leaf 0 belongs to someone else: under the sleeve's key its commitment is not in the tree.
    let mut c = case();
    c.notes[3] = Slot { is_real: true, is_v2: false, asset_slot: 0, amount: 5000 * E18, blinding: 3, index: 0, path: [0; TREE_DEPTH] };
    run(c);
}

#[test(should_fail_with = "note not in tree")]
fn note_under_wrong_asset_slot_fails() {
    let mut c = case();
    c.notes[0].asset_slot = 1;
    run(c);
}

#[test(should_fail_with = "empty asset slot")]
fn empty_asset_slot_fails() {
    let mut c = case();
    c.notes[0].asset_slot = 2;
    run(c);
}

#[test(should_fail_with = "note counted twice")]
fn same_note_twice_fails() {
    let mut c = case();
    c.notes[3] = c.notes[0];
    c.nullifiers[3] = c.nullifiers[0];
    run(c);
}

#[test(should_fail_with = "bad nullifier")]
fn wrong_nullifier_fails() {
    let mut c = case();
    c.nullifiers[0] = c.nullifiers[0] + 1;
    run(c);
}

#[test(should_fail_with = "padding slot must output a zero nullifier")]
fn padding_with_nullifier_fails() {
    let mut c = case();
    c.nullifiers[6] = 5;
    run(c);
}

#[test(should_fail_with = "bad band")]
fn band_index_must_be_0_1_2() {
    let mut c = case();
    c.private_band = 3;
    run(c);
}

#[test(should_fail)]
fn price_must_fit_96_bits() {
    let mut c = case();
    c.prices[0] = 79228162514264337593543950336; // 2^96
    c.prices_commitment = prices_commitment_of(c.assets, c.prices, c.multipliers, c.round_ids);
    run(c);
}

#[test(should_fail_with = "policy hash required")]
fn zero_policy_hash_fails() {
    let mut c = case();
    c.policy_hash = 0;
    run(c);
}
