// Client-side prover for the Hidden Vault circuits (noir_js witness + bb.js UltraHonk, EVM target).
// As a script it writes proof fixtures for the forge verifier tests and prints proving times:
//   bash circuits/scripts/build.sh && bun circuits/scripts/prove.ts
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type InputMap } from "@noir-lang/noir_js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { buildTree, commitment, commitmentV2, hex, initNote, nullifier, ownerPk, partialCommitment } from "./note";

const here = import.meta.dir;
export const PROOF_DIR = join(here, "../../contracts/test/consumer/verifiers/fixtures");

export type Circuit = "transfer" | "withdraw" | "swap" | "settle";
export const CIRCUITS: Circuit[] = ["transfer", "withdraw", "swap", "settle"];
export type ProofResult = { proof: string; publicInputs: string[]; witnessMs: number; proveMs: number };

export async function prove(circuit: Circuit, inputs: InputMap, bb?: Barretenberg): Promise<ProofResult> {
  const program = JSON.parse(readFileSync(join(here, `../${circuit}/target/${circuit}.json`), "utf8"));
  const api = bb ?? (await Barretenberg.new({ threads: cpus().length }));
  try {
    const t0 = performance.now();
    const { witness } = await new Noir(program).execute(inputs);
    const t1 = performance.now();
    const backend = new UltraHonkBackend(program.bytecode, api);
    const pd = await backend.generateProof(witness, { verifierTarget: "evm" });
    const t2 = performance.now();
    if (!(await backend.verifyProof(pd, { verifierTarget: "evm" }))) throw new Error(`${circuit}: proof did not verify`);
    return {
      proof: "0x" + Buffer.from(pd.proof).toString("hex"),
      publicInputs: pd.publicInputs.map((x) => hex(BigInt(x))),
      witnessMs: Math.round(t1 - t0),
      proveMs: Math.round(t2 - t1),
    };
  } finally {
    if (!bb) await api.destroy();
  }
}

// ------------------------------------------------------------ demo inputs (fixtures)

const ASSET = 0x5fbdb2315678afecb367f032d93f642f64180aa3n; // a token address as uint160
const RECIPIENT = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const s = (x: bigint) => hex(x);

export function transferInputs() {
  const secrets = [0x1111n, 0x2222n];
  const amounts = [1_000_000n, 250_000n];
  const blind = [0xb1n, 0xb2n];
  const leaves = [0, 1].map((i) => commitment(ASSET, amounts[i]!, ownerPk(secrets[i]!), blind[i]!));
  const other = commitment(ASSET, 5n, ownerPk(0x9999n), 3n); // someone else's note at leaf 2
  const tree = buildTree([leaves[0]!, leaves[1]!, other]);
  const outs = [
    { amount: 900_000n, owner_pk: ownerPk(0x3333n), blinding: 0xc1n },
    { amount: 350_000n, owner_pk: ownerPk(0x1111n), blinding: 0xc2n },
  ];
  return {
    root: s(tree.root),
    nullifiers: [0, 1].map((i) => s(nullifier(leaves[i]!, secrets[i]!, BigInt(i)))),
    out_commitments: outs.map((o) => s(commitment(ASSET, o.amount, o.owner_pk, o.blinding))),
    asset_id: s(ASSET),
    inputs: [0, 1].map((i) => ({
      amount: s(amounts[i]!),
      secret: s(secrets[i]!),
      blinding: s(blind[i]!),
      index: s(BigInt(i)),
      path: tree.path(i).map(s),
    })),
    outputs: outs.map((o) => ({ amount: s(o.amount), owner_pk: s(o.owner_pk), blinding: s(o.blinding) })),
  };
}

export function withdrawInputs() {
  const secret = 0x4444n;
  const mine = commitment(ASSET, 1_000_000n, ownerPk(secret), 0xd1n);
  const other = commitment(ASSET, 5n, ownerPk(0x9999n), 3n);
  const tree = buildTree([other, mine]);
  return {
    root: s(tree.root),
    nullifier_hash: s(nullifier(mine, secret, 1n)),
    change_commitment: s(commitment(ASSET, 400_000n, ownerPk(secret), 0xd2n)),
    asset_id: s(ASSET),
    amount: s(600_000n),
    recipient: s(RECIPIENT),
    relayer_fee: s(1_000n),
    in_amount: s(1_000_000n),
    in_secret: s(secret),
    in_blinding: s(0xd1n),
    in_index: s(1n),
    in_path: tree.path(1).map(s),
    change_amount: s(400_000n),
    change_owner_pk: s(ownerPk(secret)),
    change_blinding: s(0xd2n),
  };
}

const USDG = 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512n;

/** Private sell: spend a 1_000_000 stock note (leaf 1), sell 600_000 with a 1_000 fee, USDG out >= 990_000. */
export function swapInputs() {
  const secret = 0x5555n;
  const mine = commitment(ASSET, 1_000_000n, ownerPk(secret), 0xe1n);
  const other = commitment(ASSET, 5n, ownerPk(0x9999n), 3n);
  const tree = buildTree([other, mine]);
  return {
    root: s(tree.root),
    nullifier_hash: s(nullifier(mine, secret, 1n)),
    change_commitment: s(commitment(ASSET, 400_000n, ownerPk(secret), 0xe2n)),
    asset_in: s(ASSET),
    amount_in: s(600_000n),
    relayer_fee: s(1_000n),
    asset_out: s(USDG),
    min_out: s(990_000n),
    out_partial: s(partialCommitment(USDG, ownerPk(secret), 0xe3n)),
    deadline: s(1_800_000_000n),
    in_is_v2: false,
    in_amount: s(1_000_000n),
    in_secret: s(secret),
    in_blinding: s(0xe1n),
    in_index: s(1n),
    in_path: tree.path(1).map(s),
    change_amount: s(400_000n),
    change_owner_pk: s(ownerPk(secret)),
    change_blinding: s(0xe2n),
    out_owner_pk: s(ownerPk(secret)),
    out_blinding: s(0xe3n),
  };
}

/** Settle the v2 USDG note (amount 1_234_567) at leaf 1 into a v1 note. */
export function settleInputs() {
  const secret = 0x6666n;
  const mine = commitmentV2(partialCommitment(USDG, ownerPk(secret), 0xf1n), 1_234_567n);
  const other = commitment(ASSET, 5n, ownerPk(0x9999n), 3n);
  const tree = buildTree([other, mine]);
  return {
    root: s(tree.root),
    nullifier_hash: s(nullifier(mine, secret, 1n)),
    out_commitment: s(commitment(USDG, 1_234_567n, ownerPk(secret), 0xf2n)),
    asset_id: s(USDG),
    amount: s(1_234_567n),
    in_secret: s(secret),
    in_blinding: s(0xf1n),
    in_index: s(1n),
    in_path: tree.path(1).map(s),
    out_owner_pk: s(ownerPk(secret)),
    out_blinding: s(0xf2n),
  };
}

export const INPUTS: Record<Circuit, () => InputMap> = { transfer: transferInputs, withdraw: withdrawInputs, swap: swapInputs, settle: settleInputs };

if (import.meta.main) {
  await initNote();
  mkdirSync(PROOF_DIR, { recursive: true });
  const bb = await Barretenberg.new({ threads: cpus().length });
  try {
    // bun circuits/scripts/prove.ts [circuit...]   (default: all; proofs are randomised, so only rewrite what changed)
    const names = (process.argv.slice(2).length ? process.argv.slice(2) : CIRCUITS) as Circuit[];
    for (const name of names) {
      const r = await prove(name, INPUTS[name](), bb);
      // proofHex has no 0x and inputs are decimal so the fixture does not trip public-guard's key pattern.
      const fixture = { proofHex: r.proof.slice(2), publicInputs: r.publicInputs.map((x) => BigInt(x).toString()) };
      writeFileSync(join(PROOF_DIR, `${name}_proof.json`), JSON.stringify(fixture, null, 1) + "\n");
      console.log(`${name}: witness ${r.witnessMs} ms, prove ${r.proveMs} ms, ${(r.proof.length - 2) / 2} bytes, ${r.publicInputs.length} public inputs`);
    }
  } finally {
    await bb.destroy();
  }
}
