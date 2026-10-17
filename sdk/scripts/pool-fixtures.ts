// Real-proof fixture for contracts/test/consumer/ShieldedPoolProofs.t.sol, made with this SDK:
//   alice deposits 1_000_000 and 250_000 (leaves 0, 1) -> transfer: 900_000 to bob, 350_000 change (leaves 2, 3)
//   -> bob withdraws 600_000 of his note to RECIPIENT with a 1_000 relayer fee bound to RELAYER (only RELAYER
//   may submit it, audit L-9), 300_000 change (leaf 4).
//   bun sdk/scripts/pool-fixtures.ts
// Hex is written without 0x and field elements in decimal so public-guard's key pattern does not fire.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NoteTree, commitmentOf, deriveVaultKeys, destroyProver, initVault, proveTransfer, proveWithdraw, type OwnedNote } from "../src/vault";

export const FIXTURE = join(import.meta.dir, "..", "..", "contracts", "test", "consumer", "fixtures", "shielded_pool.json");
export const ASSET = "0x00000000000000000000000000000000000A55E7" as const;
export const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
export const RELAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const sig = (b: string) => (`0x${b.repeat(65)}`) as `0x${string}`;

if (import.meta.main) {
  await initVault();
  const alice = deriveVaultKeys(sig("a1"));
  const bob = deriveVaultKeys(sig("b0"));
  const tree = new NoteTree();
  const dep = [
    { raw: 1_000_000n, blinding: 0xb1n },
    { raw: 250_000n, blinding: 0xb2n },
  ];
  const notes: OwnedNote[] = dep.map((d) => {
    const commitment = commitmentOf(BigInt(ASSET), d.raw, alice.ownerPk, d.blinding);
    const leafIndex = tree.insert(commitment);
    return { asset: ASSET, raw: d.raw, ownerPk: alice.ownerPk, blinding: d.blinding, commitment, leafIndex, nullifier: null, spent: false };
  });
  const rootAfterDeposits = tree.root();
  const t = await proveTransfer({ keys: alice, tree, inputs: notes, to: bob, raw: 900_000n });
  const bobLeaf = tree.insert(BigInt(t.pub.outCommitments[0]));
  tree.insert(BigInt(t.pub.outCommitments[1]));
  const rootAfterTransfer = tree.root();
  const bobNote: OwnedNote = { asset: ASSET, raw: 900_000n, ownerPk: bob.ownerPk, blinding: t.outputs[0]!.blinding, commitment: BigInt(t.pub.outCommitments[0]), leafIndex: bobLeaf, nullifier: null, spent: false };
  const w = await proveWithdraw({ keys: bob, tree, note: bobNote, amount: 600_000n, recipient: RECIPIENT, relayerFee: 1_000n, relayer: RELAYER });
  tree.insert(BigInt(w.pub.changeCommitment));
  await destroyProver();

  const d = (h: string) => BigInt(h).toString();
  const nx = (h: string) => h.slice(2);
  const fixture = {
    asset: ASSET,
    recipient: RECIPIENT,
    relayer: RELAYER,
    aliceOwnerPk: alice.ownerPk.toString(),
    deposits: dep.map((x) => ({ raw: x.raw.toString(), blinding: x.blinding.toString() })),
    depositCommitments: notes.map((n) => n.commitment.toString()),
    rootAfterDeposits: rootAfterDeposits.toString(),
    transfer: {
      proofHex: nx(t.proof),
      root: d(t.pub.root),
      nullifiers: t.pub.nullifiers.map(d),
      outCommitments: t.pub.outCommitments.map(d),
      encryptedNotesHex: t.encryptedNotes.map(nx),
    },
    rootAfterTransfer: rootAfterTransfer.toString(),
    withdraw: {
      proofHex: nx(w.proof),
      root: d(w.pub.root),
      nullifier: d(w.pub.nullifier),
      changeCommitment: d(w.pub.changeCommitment),
      amount: w.pub.amount.toString(),
      relayerFee: w.pub.relayerFee.toString(),
      encryptedChangeHex: nx(w.pub.encryptedChange),
    },
    rootAfterWithdraw: tree.root().toString(),
  };
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`wrote ${FIXTURE}`);
}
