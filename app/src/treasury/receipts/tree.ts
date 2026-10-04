// Hourly receipts (todo 30): the Merkle tree over one hour of desk decisions.
//
// Leaf of one desk_actions row = keccak256(abi.encode(rowHash)) with rowHash = keccak256(canonical JSON of the
// whole row): every column, keys sorted, bigints as decimal strings, created_at as an ISO string. A guard denial
// is a row like any other, so it is in the tree. Leaves are ordered by desk_actions.id. Inner nodes are
// keccak256 of the two children in ascending order (OpenZeppelin's commutative hash, so MerkleProof.verify on
// chain accepts the proof); an odd node at the end of a level moves up unchanged. Same tree as
// contracts/test/treasury/Receipts.t.sol.
import { concat, encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { canonicalJson } from "@/treasury/close/bundle";

export const HOUR = 3600;
export const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex;

/** A desk_actions row as the tree sees it (the select result of the table). */
export type ActionRow = {
  id: number;
  chainId: number;
  account: string;
  desk: string;
  action: string;
  status: string;
  reasonCode: number | null;
  reason: string | null;
  adapter: string | null;
  asset: string | null;
  amount: string | null;
  notionalUsd: string | null;
  beaconKey: string | null;
  txHash: string | null;
  blockNumber: bigint | null;
  detail: unknown;
  createdAt: Date;
};

/** The exact bytes a leaf commits to (canonical JSON, nulls kept). */
export function rowJson(r: ActionRow): string {
  return canonicalJson({
    id: r.id,
    chainId: r.chainId,
    account: r.account,
    desk: r.desk,
    action: r.action,
    status: r.status,
    reasonCode: r.reasonCode,
    reason: r.reason,
    adapter: r.adapter,
    asset: r.asset,
    amount: r.amount,
    notionalUsd: r.notionalUsd,
    beaconKey: r.beaconKey,
    txHash: r.txHash,
    blockNumber: r.blockNumber === null ? null : r.blockNumber.toString(),
    detail: r.detail ?? null,
    createdAt: r.createdAt.toISOString(),
  });
}

export const rowHash = (r: ActionRow): Hex => keccak256(toBytes(rowJson(r)));
/** Receipts.leafOf(rowHash). */
export const leafOf = (h: Hex): Hex => keccak256(encodeAbiParameters([{ type: "bytes32" }], [h]));
export const leafOfRow = (r: ActionRow): Hex => leafOf(rowHash(r));

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function up(level: Hex[]): Hex[] {
  const next: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
  return next;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return ZERO_ROOT;
  let level = [...leaves];
  while (level.length > 1) level = up(level);
  return level[0]!;
}

/** Sibling path of leaf `index` (bottom up); verify with `verifyProof` or Receipts.verify. */
export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new RangeError(`leaf ${index} out of range`);
  const out: Hex[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) out.push(level[sib]!);
    level = up(level);
    i = Math.floor(i / 2);
  }
  return out;
}

/** Same check as OpenZeppelin MerkleProof.verify. */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

/** UTC epoch hour of a timestamp. */
export const hourOf = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000 / HOUR));
