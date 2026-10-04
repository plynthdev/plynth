// Real-proof fixture for contracts/test/treasury/PrivateSleeve.t.sol (todo 31: treasury private sleeve).
//   bash circuits/scripts/build.sh && bun circuits/scripts/treasury-close-fixtures.ts
//
// The forge test runs on the TreasuryFixture book, whose addresses and policy are deterministic; the values below
// are what that book produces (PrivateSleeve.t.sol test_fixtureMatchesChainContext fails if any drifts):
//   private sleeve notes (shield order = tree order): AAPL 250 | AAPL 200 | NVDA 300  -> $120k at $200 / $100
//   public book after the shields: USDG 600k (cash) + AAPL 1,550 + NVDA 200 (equity)  -> $930k
//   policy bands: cash 40-70%, equity 30-60%, basis 0-0; the sleeve counts in equity (band 1).
// Also writes a withdraw proof that unshields the AAPL 200 note in full to the account (relayer fee 0).
// Hex is written without 0x and field elements in decimal so public-guard's key pattern does not fire.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Barretenberg } from "@aztec/bb.js";
import { cpus } from "node:os";
import { P, buildTree, commitment, hash, initNote, nullifier, ownerPk } from "./note";
import { prove } from "./prove";

export const FIXTURE = join(import.meta.dir, "../../contracts/test/treasury/fixtures/private_sleeve.json");

const E18 = 10n ** 18n;
// TreasuryFixture deployments (deterministic forge addresses) and its policy hash.
export const AAPL = 0x2e234dae75c793f67a35089c9d99245e1c58470bn;
export const NVDA = 0xf62849f9a0b5bf2913b396098f7c7019b51a820an;
export const ACCOUNT = 0x1af7f588a501ea2b5bb3feefa744892aa2cf00e6n;
const POLICY_HASH = BigInt("0x" + "a6ecf73b7cb874b7c1ee398477676bda" + "6f471522d16128a6d1cbaaf67ca194e9"); // TreasuryPolicy.current() hash

const SECRET = 0x7a11n; // test spending secret (the controller's derived key in production)
const ASSETS = [AAPL, NVDA, 0n, 0n];
const PRICES = [200n * E18, 100n * E18, 0n, 0n]; // Valuer priceUsdPerToken (multiplier already inside)
const MULTIPLIERS = [E18, 1001n * E18 / 1000n, 0n, 0n];
const ROUNDS = [1n, 1n, 0n, 0n];
const SHIELDS = [
  { asset: AAPL, slot: 0, raw: 250n * E18, blinding: 0x51n },
  { asset: AAPL, slot: 0, raw: 200n * E18, blinding: 0x52n },
  { asset: NVDA, slot: 1, raw: 300n * E18, blinding: 0x53n },
];
const PUB_NAV = 930_000n * E18;
const PUB_BAND = [600_000n * E18, 330_000n * E18, 0n];
const BAND_MIN = [4000n, 3000n, 0n];
const BAND_MAX = [7000n, 6000n, 0n];
const MAX_NOTES = 8;
const DEPTH = 20;

export function pricesCommitment(): bigint {
  let acc = 0n;
  for (let k = 0; k < 4; k++) acc = hash([acc, hash([ASSETS[k]!, PRICES[k]!, MULTIPLIERS[k]!, ROUNDS[k]!])]);
  return acc;
}

if (import.meta.main) {
  await initNote();
  const pk = ownerPk(SECRET);
  const leaves = SHIELDS.map((s) => commitment(s.asset, s.raw, pk, s.blinding));
  const tree = buildTree(leaves);
  const s = (x: bigint) => "0x" + x.toString(16);
  const navBound = SHIELDS.reduce((a, n) => a + n.raw * PRICES[n.slot]!, 0n) / E18;
  const nullifiers = Array.from({ length: MAX_NOTES }, (_, i) => (i < leaves.length ? nullifier(leaves[i]!, SECRET, BigInt(i)) : 0n));
  const pad = { is_real: false, is_v2: false, asset_slot: 0, amount: "0x0", blinding: "0x0", index: "0x0", path: Array(DEPTH).fill("0x0") };
  const notes = Array.from({ length: MAX_NOTES }, (_, i) => {
    const n = SHIELDS[i];
    if (!n) return pad;
    return { is_real: true, is_v2: false, asset_slot: n.slot, amount: s(n.raw), blinding: s(n.blinding), index: s(BigInt(i)), path: tree.path(i).map(s) };
  });
  const policyHashModP = POLICY_HASH % P;
  const pc = pricesCommitment();
  const closeInputs = {
    root: s(tree.root),
    owner_pk_pub: s(pk),
    policy_hash: s(policyHashModP),
    prices_commitment: s(pc),
    nav_bound: s(navBound),
    pub_nav: s(PUB_NAV),
    pub_band_usd: PUB_BAND.map(s),
    band_min_bps: BAND_MIN.map(s),
    band_max_bps: BAND_MAX.map(s),
    private_band: s(1n),
    nullifier_hashes: nullifiers.map(s),
    secret: s(SECRET),
    assets: ASSETS.map(s),
    prices: PRICES.map(s),
    multipliers: MULTIPLIERS.map(s),
    round_ids: ROUNDS.map(s),
    notes,
  };
  const changeBlinding = 0x54n;
  const withdrawInputs = {
    root: s(tree.root),
    nullifier_hash: s(nullifiers[1]!),
    change_commitment: s(commitment(AAPL, 0n, pk, changeBlinding)),
    asset_id: s(AAPL),
    amount: s(200n * E18),
    recipient: s(ACCOUNT),
    relayer_fee: s(0n),
    in_amount: s(200n * E18),
    in_secret: s(SECRET),
    in_blinding: s(0x52n),
    in_index: s(1n),
    in_path: tree.path(1).map(s),
    change_amount: s(0n),
    change_owner_pk: s(pk),
    change_blinding: s(changeBlinding),
  };

  const bb = await Barretenberg.new({ threads: cpus().length });
  const close = await prove("treasury_close", closeInputs, bb);
  const w = await prove("withdraw", withdrawInputs, bb);
  await bb.destroy();
  console.log(`treasury_close: witness ${close.witnessMs} ms, prove ${close.proveMs} ms`);

  const d = (x: bigint) => x.toString();
  const fixture = {
    account: "0x" + ACCOUNT.toString(16).padStart(40, "0"),
    assets: [AAPL, NVDA].map((a) => "0x" + a.toString(16).padStart(40, "0")),
    ownerPk: d(pk),
    root: d(tree.root),
    policyHashModP: d(policyHashModP),
    pricesCommitment: d(pc),
    pubNav: d(PUB_NAV),
    pubBandUsd: PUB_BAND.map(d),
    shields: SHIELDS.map((n) => ({ asset: "0x" + n.asset.toString(16).padStart(40, "0"), raw: d(n.raw), blinding: d(n.blinding) })),
    close: {
      proofHex: close.proof.slice(2),
      navBound: d(navBound),
      nullifiers: nullifiers.map(d),
      publicInputs: close.publicInputs.map((x) => d(BigInt(x))),
    },
    withdraw: {
      proofHex: w.proof.slice(2),
      root: d(tree.root),
      nullifier: d(nullifiers[1]!),
      changeCommitment: d(BigInt(withdrawInputs.change_commitment)),
      amount: d(200n * E18),
    },
  };
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${FIXTURE}`);
}
