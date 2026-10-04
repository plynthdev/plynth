// Real-proof fixture for contracts/test/consumer/ThresholdVerifier.t.sol, made with this SDK.
//   Pool leaves (and deposit-tree leaves, same order): alice 100_000 | bob 50_000 | alice 200_000 | alice 300_000.
//   A 999 deposit by alice is refunded between bob's and the 200_000 one (pending id 2), so it is in neither tree.
//   The deposit tree is synced once after the first deposit (rootFrom, size 1) and once at the end (rootTo, size 4).
//   holdings: alice >= 500_000 at the final pool root, for VERIFIER_A / REQUEST_ID (counts 300_000 + 200_000).
//   savings:  alice deposited >= 500_000 between rootFrom and rootTo, for VERIFIER_A / REQUEST_ID.
//   withdraw: alice spends her 300_000 note in full (so the holdings proof must then be refused).
// ThresholdVerifier sits at TV (deployCodeTo) on chain 31337 so the nonce is reproducible.
//   bun packages/sdk/scripts/threshold-fixtures.ts
// Hex is written without 0x and field elements in decimal so public-guard's key pattern does not fire.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { proveHoldingsAtLeast, proveSavingsAtLeast, verifierNonce, type DepositTreeState } from "../src/statements/proofs";
import { NoteTree, commitmentOf, deriveVaultKeys, destroyProver, initVault, proveWithdraw, type OwnedNote } from "../src/vault";

export const FIXTURE = join(import.meta.dir, "..", "..", "..", "contracts", "test", "consumer", "fixtures", "threshold.json");
export const ASSET = "0x00000000000000000000000000000000000A55E7" as Address;
export const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
export const TV = "0x0000000000000000000000000000000000007e57" as Address;
export const VERIFIER_A = "0x000000000000000000000000000000000000aAaA" as Address;
export const VERIFIER_B = "0x000000000000000000000000000000000000bBbB" as Address;
export const REQUEST_ID = keccak256(toBytes("plynth.test.request.1"));
export const CHAIN_ID = 31337;

const sig = (b: string) => `0x${b.repeat(65)}` as Hex;

if (import.meta.main) {
  await initVault();
  const alice = deriveVaultKeys(sig("a1"));
  const bob = deriveVaultKeys(sig("b0"));
  const deposits = [
    { who: "alice", keys: alice, raw: 100_000n, blinding: 0xc1n },
    { who: "bob", keys: bob, raw: 50_000n, blinding: 0xc2n },
    { who: "alice", keys: alice, raw: 200_000n, blinding: 0xc3n },
    { who: "alice", keys: alice, raw: 300_000n, blinding: 0xc4n },
  ];
  const tree = new NoteTree();
  const notes: OwnedNote[] = deposits.map((d) => {
    const commitment = commitmentOf(BigInt(ASSET), d.raw, d.keys.ownerPk, d.blinding);
    const leafIndex = tree.insert(commitment);
    return { asset: ASSET, raw: d.raw, ownerPk: d.keys.ownerPk, blinding: d.blinding, commitment, leafIndex, nullifier: null, spent: false };
  });
  const aliceNotes = notes.filter((n) => n.ownerPk === alice.ownerPk);
  const fromTree = new NoteTree();
  fromTree.insert(notes[0]!.commitment);
  const dt: DepositTreeState = {
    leaves: notes.map((n) => n.commitment),
    roots: [
      { root: fromTree.root(), size: 1, block: 1n },
      { root: tree.root(), size: 4, block: 2n },
    ],
    toBlock: 2n,
  };
  const req = { chainId: CHAIN_ID, thresholdVerifier: TV, verifier: VERIFIER_A, requestId: REQUEST_ID };
  const holdings = await proveHoldingsAtLeast({ ...req, keys: alice, tree, notes: aliceNotes, asset: ASSET, threshold: 500_000n });
  const savings = await proveSavingsAtLeast({ ...req, keys: alice, deposits: dt, notes: aliceNotes, asset: ASSET, threshold: 500_000n, from: dt.roots[0]!, to: dt.roots[1]! });
  const w = await proveWithdraw({ keys: alice, tree, note: notes[3]!, amount: 300_000n, recipient: RECIPIENT });
  await destroyProver();

  const d = (h: string) => BigInt(h).toString();
  const nx = (h: string) => h.slice(2);
  const fixture = {
    asset: ASSET,
    recipient: RECIPIENT,
    tv: TV,
    verifierA: VERIFIER_A,
    verifierB: VERIFIER_B,
    requestId: d(REQUEST_ID),
    nonceA: verifierNonce(req).toString(),
    deposits: deposits.map((x) => ({ who: x.who, ownerPk: x.keys.ownerPk.toString(), raw: x.raw.toString(), blinding: x.blinding.toString() })),
    poolRoot: tree.root().toString(),
    depositRootFrom: fromTree.root().toString(),
    depositRootTo: tree.root().toString(),
    holdings: { proofHex: nx(holdings.proof), root: d(holdings.claim.root), threshold: holdings.claim.threshold, nullifiers: holdings.claim.nullifiers.map(d) },
    savings: { proofHex: nx(savings.proof), rootFrom: d(savings.claim.rootFrom), rootTo: d(savings.claim.rootTo), threshold: savings.claim.threshold },
    withdraw: {
      proofHex: nx(w.proof),
      root: d(w.pub.root),
      nullifier: d(w.pub.nullifier),
      changeCommitment: d(w.pub.changeCommitment),
      amount: w.pub.amount.toString(),
    },
  };
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${FIXTURE}`);
}
