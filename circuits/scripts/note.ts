// Hidden Vault note model in TypeScript (mirror of circuits/hidden/src/lib.nr).
// Poseidon2 permutation comes from Barretenberg (bb.js), the same code the prover uses;
// the sponge around it is checked against Noir by fixtures.test.ts.
import { BarretenbergSync, BN254_FR_MODULUS } from "@aztec/bb.js";
import constants from "../constants.json" with { type: "json" };

export const P = BN254_FR_MODULUS;
export const TREE_DEPTH: number = constants.treeDepth;
export const ZERO_LEAF = BigInt(constants.zeroLeaf);

let bb: BarretenbergSync | undefined;
async function api(): Promise<BarretenbergSync> {
  bb ??= await BarretenbergSync.new();
  return bb;
}
/** Call once before using the sync helpers below. */
export async function initNote(): Promise<void> {
  await api();
}

const toBytes = (x: bigint): Uint8Array => {
  if (x < 0n || x >= P) throw new Error(`not a field element: ${x}`);
  return Uint8Array.from(Buffer.from(x.toString(16).padStart(64, "0"), "hex"));
};
const fromBytes = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));

export function permutation(state: readonly bigint[]): bigint[] {
  if (!bb) throw new Error("call initNote() first");
  if (state.length !== 4) throw new Error("state must have 4 elements");
  return bb.poseidon2Permutation({ inputs: state.map(toBytes) }).outputs.map(fromBytes);
}

/** Poseidon2 sponge, Noir stdlib Poseidon2Hasher semantics (rate 3, IV = len << 64). */
export function hash(inputs: readonly bigint[]): bigint {
  const n = inputs.length;
  let s = [0n, 0n, 0n, BigInt(n) << 64n];
  for (let i = 0; i < Math.floor(n / 3); i++) {
    for (let j = 0; j < 3; j++) s[j] = (s[j]! + inputs[i * 3 + j]!) % P;
    s = permutation(s);
  }
  const absorbed = Math.floor(n / 3) * 3;
  for (let i = 0; i < n % 3; i++) s[i] = (s[i]! + inputs[absorbed + i]!) % P;
  return permutation(s)[0]!;
}

export const ownerPk = (spendingSecret: bigint) => hash([spendingSecret]);
export const commitment = (assetId: bigint, rawAmount: bigint, ownerPk: bigint, blinding: bigint) =>
  hash([assetId, rawAmount, ownerPk, blinding]);
export const partialCommitment = (assetId: bigint, ownerPk: bigint, blinding: bigint) => hash([assetId, ownerPk, blinding]);
export const commitmentV2 = (partial: bigint, rawAmount: bigint) => hash([partial, rawAmount]);
export const nullifier = (commitment: bigint, spendingSecret: bigint, leafIndex: bigint) =>
  hash([commitment, spendingSecret, leafIndex]);
export const hashNode = (l: bigint, r: bigint) => hash([l, r]);

export function zeroHashes(): bigint[] {
  const z = [ZERO_LEAF];
  for (let i = 0; i < TREE_DEPTH; i++) z.push(hashNode(z[i]!, z[i]!));
  return z;
}

/** Sparse in-memory tree: leaves at 0..n-1, everything else empty. */
export function buildTree(leaves: readonly bigint[]): { root: bigint; path: (index: number) => bigint[] } {
  const zeros = zeroHashes();
  const levels: bigint[][] = [leaves.slice()];
  for (let d = 0; d < TREE_DEPTH; d++) {
    const cur = levels[d]!;
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(hashNode(cur[i]!, cur[i + 1] ?? zeros[d]!));
    levels.push(next);
  }
  const root = levels[TREE_DEPTH]![0] ?? zeros[TREE_DEPTH]!;
  const path = (index: number) =>
    Array.from({ length: TREE_DEPTH }, (_, d) => levels[d]![(index >> d) ^ 1] ?? zeros[d]!);
  return { root, path };
}

export const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
