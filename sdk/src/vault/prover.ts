// Client-side proofs for ShieldedPool (noir_js witness + bb.js UltraHonk, EVM target), and the matching
// public structs and encrypted notes. Circuits: artifacts/transfer.json, artifacts/withdraw.json
// (compact copies of circuits/<c>/target, see scripts/sync-circuits.ts).
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import transferArtifact from "./artifacts/transfer.json" with { type: "json" };
import withdrawArtifact from "./artifacts/withdraw.json" with { type: "json" };
import { encryptNote } from "./ecies";
import type { VaultKeys } from "./keys";
import { MAX_RAW, P, TREE_DEPTH, commitmentOf, nullifierOf, randomField, toBytes32 } from "./note";
import type { OwnedNote } from "./sync";
import type { NoteTree } from "./tree";

export type PublicTransfer = { root: Hex; nullifiers: readonly [Hex, Hex]; outCommitments: readonly [Hex, Hex]; asset: Address };
export type PublicWithdraw = {
  root: Hex;
  nullifier: Hex;
  changeCommitment: Hex;
  asset: Address;
  amount: bigint;
  recipient: Address;
  relayerFee: bigint;
  encryptedChange: Hex;
};
export type Recipient = { ownerPk: bigint; viewingPub: Uint8Array };

let api: Promise<Barretenberg> | undefined;
const backend = () => (api ??= Barretenberg.new({ threads: typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4 }));

/** Frees the Barretenberg worker(s); proving again re-creates them. */
export async function destroyProver(): Promise<void> {
  if (!api) return;
  const b = await api;
  api = undefined;
  await b.destroy();
}

/** Witness + UltraHonk proof (EVM target) for a compiled Noir program. */
export async function proveCircuit(program: { bytecode: string; abi: unknown }, inputs: Record<string, unknown>): Promise<{ proof: Hex; publicInputs: bigint[] }> {
  const { witness } = await new Noir(program as any).execute(inputs as any);
  const be = new UltraHonkBackend(program.bytecode, await backend());
  const pd = await be.generateProof(witness, { verifierTarget: "evm" });
  return { proof: `0x${Buffer.from(pd.proof).toString("hex")}`, publicInputs: pd.publicInputs.map((x) => BigInt(x)) };
}

const f = (x: bigint) => toBytes32(x);

/** ShieldedPool/ShieldedTrade.extHashOf: keccak256(data) mod p. The public input that binds a spend's encrypted
 *  notes to its proof, so whoever submits it (a relayer) cannot replace them. */
export function extHashOf(data: Hex): bigint {
  return BigInt(keccak256(data)) % P;
}

/** abi.encode(bytes, bytes): what transfer (two output notes) and swap (change, output) hash. */
export function encodeTwoNotes(a: Hex, b: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [a, b]);
}

/** The bytes a withdraw's ext_hash covers: the encrypted change, plus (abi.encode(change, relayer)) the
 *  relayer when a fee is paid, so only that address can submit the proof and take the fee (audit L-9). */
export function withdrawExtData(encryptedChange: Hex, relayerFee: bigint, relayer?: Address): Hex {
  if (relayerFee === 0n) return encryptedChange;
  if (!relayer) throw new Error("a relayer fee needs the relayer's address: the proof binds who may submit it");
  return encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [encryptedChange, getAddress(relayer)]);
}

/** The bytes a swap's ext_hash covers: abi.encode(change, out), plus the relayer when a fee is paid (audit L-9). */
export function swapExtData(encryptedChange: Hex, encryptedOut: Hex, relayerFee: bigint, relayer?: Address): Hex {
  if (relayerFee === 0n) return encodeTwoNotes(encryptedChange, encryptedOut);
  if (!relayer) throw new Error("a relayer fee needs the relayer's address: the proof binds who may submit it");
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "address" }], [encryptedChange, encryptedOut, getAddress(relayer)]);
}

/** Throws unless `n` is inserted, unspent and in the local tree. v2 notes (swap outputs) need `allowV2`
 * (the swap circuit); transfer/withdraw take v1 only, so settle a v2 note first (proveSettle). */
export function spendable(n: OwnedNote, tree: NoteTree, allowV2 = false): asserts n is OwnedNote & { leafIndex: number } {
  if (n.version === 2 && !allowV2) throw new Error("v2 note (swap output): settle it first (proveSettle)");
  if (n.leafIndex === null) throw new Error("note is still pending (not in the tree yet)");
  if (n.spent) throw new Error("note already spent");
  if (tree.leaf(n.leafIndex) !== n.commitment) throw new Error("local tree does not hold this note: sync first");
}

/**
 * Private transfer: 1-2 input notes of one asset (owned by `keys`) -> up to 2 outputs. Whatever is not sent
 * comes back to `keys` as change. A missing input is a zero-value dummy; a missing output is a zero note to self.
 */
export async function proveTransfer(p: {
  keys: VaultKeys;
  tree: NoteTree;
  inputs: OwnedNote[];
  to: Recipient;
  raw: bigint;
}): Promise<{ proof: Hex; pub: PublicTransfer; encryptedNotes: readonly [Hex, Hex]; outputs: { raw: bigint; ownerPk: bigint; blinding: bigint }[] }> {
  const { keys, tree } = p;
  if (p.inputs.length < 1 || p.inputs.length > 2) throw new Error("1 or 2 input notes");
  const asset = getAddress(p.inputs[0]!.asset);
  for (const n of p.inputs) {
    if (getAddress(n.asset) !== asset) throw new Error("all inputs must be the same asset");
    spendable(n, tree);
  }
  const total = p.inputs.reduce((a, n) => a + n.raw, 0n);
  if (p.raw < 0n || p.raw > total) throw new Error(`cannot send ${p.raw} from ${total}`);
  const assetId = BigInt(asset);
  // One proof proves membership under one root: the inputs' tree (the pool archives full trees' roots).
  const treeId = tree.treeOf(p.inputs[0]!.leafIndex!);
  if (p.inputs.some((n) => tree.treeOf(n.leafIndex!) !== treeId)) throw new Error("inputs are in different trees: transfer them separately");
  const root = tree.rootOf(p.inputs[0]!.leafIndex!);

  const ins = p.inputs.map((n) => ({ amount: n.raw, secret: keys.spendingSecret, blinding: n.blinding, index: BigInt(tree.position(n.leafIndex!)), path: tree.path(n.leafIndex!) }));
  if (ins.length === 1) ins.push({ amount: 0n, secret: keys.spendingSecret, blinding: randomField(), index: 0n, path: Array(TREE_DEPTH).fill(0n) });
  const nullifiers = ins.map((i) => nullifierOf(commitmentOf(assetId, i.amount, keys.ownerPk, i.blinding), i.secret, i.index));

  const outs = [
    { raw: p.raw, ownerPk: p.to.ownerPk, blinding: randomField(), viewingPub: p.to.viewingPub },
    { raw: total - p.raw, ownerPk: keys.ownerPk, blinding: randomField(), viewingPub: keys.viewingPub },
  ];
  // A zero-value output is commitment 0 (no leaf, no ciphertext): the pool skips it.
  const outCommitments = outs.map((o) => (o.raw === 0n ? 0n : commitmentOf(assetId, o.raw, o.ownerPk, o.blinding)));
  // Encrypted before proving: the proof binds them (ext_hash), so they cannot be swapped on the way to the chain.
  const enc = (o: (typeof outs)[number]): Hex => (o.raw === 0n ? "0x" : encryptNote({ asset, raw: o.raw, blinding: o.blinding }, o.viewingPub));
  const encryptedNotes = [enc(outs[0]!), enc(outs[1]!)] as const;

  const { proof } = await proveCircuit(transferArtifact, {
    root: f(root),
    nullifiers: nullifiers.map(f),
    out_commitments: outCommitments.map(f),
    asset_id: f(assetId),
    ext_hash: f(extHashOf(encodeTwoNotes(encryptedNotes[0], encryptedNotes[1]))),
    inputs: ins.map((i) => ({ amount: f(i.amount), secret: f(i.secret), blinding: f(i.blinding), index: f(i.index), path: i.path.map(f) })),
    outputs: outs.map((o) => ({ amount: f(o.raw), owner_pk: f(o.ownerPk), blinding: f(o.blinding) })),
  });
  return {
    proof,
    pub: { root: f(root), nullifiers: [f(nullifiers[0]!), f(nullifiers[1]!)], outCommitments: [f(outCommitments[0]!), f(outCommitments[1]!)], asset },
    encryptedNotes,
    outputs: outs.map(({ raw, ownerPk, blinding }) => ({ raw, ownerPk, blinding })),
  };
}

/** Withdraw `amount` of one note: amount - relayerFee to `recipient`, relayerFee to `relayer`; change to self.
 *  With a fee, `relayer` is required and only that address can submit the proof (its /health `relayer`). */
export async function proveWithdraw(p: {
  keys: VaultKeys;
  tree: NoteTree;
  note: OwnedNote;
  amount: bigint;
  recipient: Address;
  relayerFee?: bigint;
  relayer?: Address;
}): Promise<{ proof: Hex; pub: PublicWithdraw }> {
  const { keys, tree, note } = p;
  spendable(note, tree);
  const fee = p.relayerFee ?? 0n;
  if (p.amount < 0n || p.amount > note.raw || p.amount > MAX_RAW) throw new Error(`cannot withdraw ${p.amount} from ${note.raw}`);
  if (fee < 0n || fee > p.amount) throw new Error("relayer fee exceeds amount");
  if (fee !== 0n && !p.relayer) throw new Error("a relayer fee needs the relayer's address: the proof binds who may submit it");
  const asset = getAddress(note.asset);
  const assetId = BigInt(asset);
  const recipient = getAddress(p.recipient);
  const root = tree.rootOf(note.leafIndex);
  const position = BigInt(tree.position(note.leafIndex));
  const nullifier = nullifierOf(note.commitment, keys.spendingSecret, position);
  const change = note.raw - p.amount;
  const changeBlinding = randomField();
  // Zero change: commitment 0 and no ciphertext; the pool inserts no leaf (a full exit needs no tree space).
  const changeCommitment = change === 0n ? 0n : commitmentOf(assetId, change, keys.ownerPk, changeBlinding);
  const encryptedChange: Hex = change === 0n ? "0x" : encryptNote({ asset, raw: change, blinding: changeBlinding }, keys.viewingPub);
  const { proof } = await proveCircuit(withdrawArtifact, {
    root: f(root),
    nullifier_hash: f(nullifier),
    change_commitment: f(changeCommitment),
    asset_id: f(assetId),
    amount: f(p.amount),
    recipient: f(BigInt(recipient)),
    relayer_fee: f(fee),
    ext_hash: f(extHashOf(withdrawExtData(encryptedChange, fee, p.relayer))),
    in_amount: f(note.raw),
    in_secret: f(keys.spendingSecret),
    in_blinding: f(note.blinding),
    in_index: f(position),
    in_path: tree.path(note.leafIndex).map(f),
    change_amount: f(change),
    change_owner_pk: f(keys.ownerPk),
    change_blinding: f(changeBlinding),
  });
  return {
    proof,
    pub: {
      root: f(root),
      nullifier: f(nullifier),
      changeCommitment: f(changeCommitment),
      asset,
      amount: p.amount,
      recipient,
      relayerFee: fee,
      encryptedChange,
    },
  };
}

/** Checks an EVM-target UltraHonk proof against a compiled program's verification key (no chain state). */
export async function verifyCircuitProof(program: { bytecode: string }, proof: Hex, publicInputs: readonly bigint[]): Promise<boolean> {
  const be = new UltraHonkBackend(program.bytecode, await backend());
  try {
    return await be.verifyProof({ proof: Buffer.from(proof.slice(2), "hex"), publicInputs: publicInputs.map((x) => toBytes32(x)) }, { verifierTarget: "evm" });
  } catch {
    return false;
  }
}
