// Hidden Vault note model (mirror of circuits/hidden/src/lib.nr and ShieldedPool.commitmentOf).
// Poseidon2 permutation from Barretenberg (bb.js), the same code the prover uses.
import { BackendType, BarretenbergSync } from "@aztec/bb.js";

/** bn254 scalar field modulus. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_DEPTH = 20;
/** keccak256("plynth.hidden.zero-leaf") mod p (circuits/constants.json). */
export const ZERO_LEAF = 19775478028315771982975137691107476491441223034782917916729230798959553774862n;
export const MAX_RAW = (1n << 128n) - 1n;

let bb: BarretenbergSync | undefined;
let pending: Promise<BarretenbergSync> | undefined;

/** Loads Barretenberg once; call (await) before any hash helper. */
export async function initVault(): Promise<void> {
  if (bb) return;
  // WASM, not the native shared-memory backend: the native one can deadlock a synchronous call (two
  // `bb msgpack run` processes idle forever, the event loop blocked) and hashing gains nothing from it.
  pending ??= BarretenbergSync.new({ backend: BackendType.Wasm });
  bb = await pending;
}

const toBytes = (x: bigint): Uint8Array => {
  if (x < 0n || x >= P) throw new Error(`not a field element: ${x}`);
  return Uint8Array.from(Buffer.from(x.toString(16).padStart(64, "0"), "hex"));
};
const fromBytes = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));

export function permutation(state: readonly bigint[]): bigint[] {
  if (!bb) throw new Error("call initVault() first");
  return bb.poseidon2Permutation({ inputs: state.map(toBytes) }).outputs.map(fromBytes);
}

/** Poseidon2 sponge, Noir stdlib semantics (rate 3, IV = len << 64). */
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

export const ownerPkOf = (spendingSecret: bigint) => hash([spendingSecret]);
export const commitmentOf = (assetId: bigint, raw: bigint, ownerPk: bigint, blinding: bigint) => hash([assetId, raw, ownerPk, blinding]);
/** v2 ("partial") notes, made by ShieldedTrade swaps: the amount is appended on-chain (circuits/hidden lib.nr). */
export const partialCommitmentOf = (assetId: bigint, ownerPk: bigint, blinding: bigint) => hash([assetId, ownerPk, blinding]);
export const commitmentV2Of = (partial: bigint, raw: bigint) => hash([partial, raw]);
export const nullifierOf = (commitment: bigint, spendingSecret: bigint, leafIndex: bigint) => hash([commitment, spendingSecret, leafIndex]);
export const hashNode = (l: bigint, r: bigint) => hash([l, r]);

let zerosCache: bigint[] | undefined;
export function zeroHashes(): bigint[] {
  if (zerosCache) return zerosCache;
  const z = [ZERO_LEAF];
  for (let i = 0; i < TREE_DEPTH; i++) z.push(hashNode(z[i]!, z[i]!));
  zerosCache = z;
  return z;
}

/** A uniformly random field element (248 random bits, always < p). */
export function randomField(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(31));
  return BigInt("0x" + Buffer.from(b).toString("hex"));
}

export const toBytes32 = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(64, "0")}`;

/** A note: raw token base units of `asset`, owned by `ownerPk`. `version` 2 = a swap output (default 1). */
export type Note = { asset: `0x${string}`; raw: bigint; ownerPk: bigint; blinding: bigint; version?: 1 | 2 };
export const noteCommitment = (n: Note) =>
  n.version === 2
    ? commitmentV2Of(partialCommitmentOf(BigInt(n.asset), n.ownerPk, n.blinding), n.raw)
    : commitmentOf(BigInt(n.asset), n.raw, n.ownerPk, n.blinding);
