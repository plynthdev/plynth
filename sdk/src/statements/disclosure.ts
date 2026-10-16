// Scoped disclosure without handing over keys. The user opens chosen notes (asset, raw, ownerPk, blinding,
// leafIndex) plus a Merkle path to the pool's root at period end; a verifier recomputes each commitment,
// checks the path against that root, checks the root really was the pool's root at the end of the period
// (RootUpdated events), and checks each disclosed nullifier against NullifierSpent events.
// The verifier learns the disclosed notes and nothing else: no viewing key, no spending key, no other note.
// Linking limits are written up in the SDK README.
import { getAddress, isAddress, isHex, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { nullifierSpentEvent } from "../vault/abi";
import { MAX_RAW, P, TREE_DEPTH, commitmentOf, hashNode, initVault, toBytes32 } from "../vault/note";
import { NoteTree } from "../vault/tree";
import { logsChunked, rootUpdatedEvent, type PoolHistory } from "./scan";
import type { Period, StatementNote } from "./statement";

export type DisclosedNote = {
  asset: Address;
  raw: string;
  ownerPk: Hex;
  blinding: Hex;
  leafIndex: number;
  /** Sibling path, bottom-up, to `bundle.root`. */
  path: Hex[];
  /** Optional: lets the verifier check spent status. The verifier cannot check it belongs to this note. */
  nullifier?: Hex;
};

export type DisclosureBundle = {
  version: 1;
  kind: "plynth.disclosure";
  chainId: number;
  pool: Address;
  period: { fromBlock: string; toBlock: string };
  /** The pool's root at period end (the last RootUpdated at or before toBlock). */
  root: Hex;
  notes: DisclosedNote[];
};

type Disclosable = Pick<StatementNote, "asset" | "raw" | "ownerPk" | "blinding" | "leafIndex" | "nullifier"> & { commitment: bigint };

/**
 * Opens `notes` for `period`. `history` must cover the pool from its deploy block to period.toBlock
 * (statement() scans it; pass the same scan). Notes must be in the tree by period end.
 */
export function discloseNotes(
  notes: Disclosable[],
  period: Period,
  ctx: { chainId: number; pool: Address; history: PoolHistory; includeNullifiers?: boolean },
): DisclosureBundle {
  if (!notes.length) throw new Error("nothing to disclose");
  if (ctx.history.toBlock < period.toBlock) throw new Error("history does not reach period end");
  const tree = new NoteTree();
  for (const l of ctx.history.leaves) if (l.block <= period.toBlock) tree.insert(l.commitment);
  const seen = new Set<number>();
  const out = notes.map((n) => {
    if (n.leafIndex === null || n.leafIndex >= tree.size) throw new Error(`note ${toBytes32(n.commitment)} is not in the tree by period end`);
    if (tree.leaf(n.leafIndex) !== n.commitment) throw new Error(`leaf ${n.leafIndex} is not this note`);
    if (seen.has(n.leafIndex)) throw new Error(`leaf ${n.leafIndex} disclosed twice`);
    seen.add(n.leafIndex);
    const d: DisclosedNote = {
      asset: getAddress(n.asset),
      raw: n.raw.toString(),
      ownerPk: toBytes32(n.ownerPk),
      blinding: toBytes32(n.blinding),
      leafIndex: n.leafIndex,
      path: tree.path(n.leafIndex).map(toBytes32),
    };
    if ((ctx.includeNullifiers ?? true) && n.nullifier !== null && n.nullifier !== undefined) d.nullifier = toBytes32(n.nullifier);
    return d;
  });
  return {
    version: 1,
    kind: "plynth.disclosure",
    chainId: ctx.chainId,
    pool: getAddress(ctx.pool),
    period: { fromBlock: period.fromBlock.toString(), toBlock: period.toBlock.toString() },
    root: toBytes32(tree.root()),
    notes: out,
  };
}

export type NoteVerdict = {
  ok: boolean;
  leafIndex: number;
  asset: Address | null;
  raw: string;
  commitment: Hex | null;
  /** spent/unspent at period end per the disclosed nullifier; not-disclosed when none was given. */
  nullifierStatus: "unspent" | "spent" | "spent-after-period" | "not-disclosed";
  spentBlock: string | null;
  error: string | null;
};

export type DisclosureVerdict = {
  ok: boolean;
  chainId: number | null;
  pool: Address | null;
  period: { fromBlock: string; toBlock: string } | null;
  root: Hex | null;
  rootBlock: string | null;
  notes: NoteVerdict[];
  /** Per asset: verified notes not shown spent at period end. */
  totals: { asset: Address; raw: string }[];
  errors: string[];
};

/** Notes one bundle may disclose (a verifier may pass a lower `maxNotes`, the API does). */
export const MAX_NOTES = 256;
/** Nullifiers per NullifierSpent getLogs (an OR on the indexed topic). */
const NULLIFIER_BATCH = 64;
const word = (x: unknown): x is Hex => typeof x === "string" && isHex(x) && x.length === 66;
const field = (x: unknown) => word(x) && BigInt(x) < P;

/** Structural checks only (no chain). Returns the problems found. */
export function checkBundleShape(b: unknown, maxNotes = MAX_NOTES): string[] {
  const e: string[] = [];
  const x = b as Partial<DisclosureBundle> | null;
  if (!x || typeof x !== "object") return ["bundle must be an object"];
  if (x.version !== 1 || x.kind !== "plynth.disclosure") e.push("not a plynth.disclosure v1 bundle");
  if (!Number.isSafeInteger(x.chainId)) e.push("chainId must be an integer");
  if (typeof x.pool !== "string" || !isAddress(x.pool, { strict: false })) e.push("pool must be an address");
  const blk = (s: unknown) => typeof s === "string" && /^\d{1,20}$/.test(s);
  if (!x.period || !blk(x.period.fromBlock) || !blk(x.period.toBlock) || BigInt(x.period.fromBlock) > BigInt(x.period.toBlock)) e.push("period must be {fromBlock, toBlock} block numbers, from <= to");
  if (!field(x.root)) e.push("root must be a 32-byte field element");
  const max = Math.min(maxNotes, MAX_NOTES);
  if (!Array.isArray(x.notes) || x.notes.length === 0 || x.notes.length > max) e.push(`notes must be 1..${max} entries`);
  return e;
}

function noteShape(n: Partial<DisclosedNote>): string | null {
  if (!n || typeof n !== "object") return "note must be an object";
  if (typeof n.asset !== "string" || !isAddress(n.asset, { strict: false })) return "asset must be an address";
  if (typeof n.raw !== "string" || !/^\d{1,39}$/.test(n.raw) || BigInt(n.raw) > MAX_RAW) return "raw must be a base-unit integer below 2^128";
  if (!field(n.ownerPk) || !field(n.blinding)) return "ownerPk and blinding must be field elements";
  if (!Number.isSafeInteger(n.leafIndex) || n.leafIndex! < 0 || n.leafIndex! >= 2 ** TREE_DEPTH) return "leafIndex out of range";
  if (!Array.isArray(n.path) || n.path.length !== TREE_DEPTH || !n.path.every(field)) return `path must be ${TREE_DEPTH} field elements`;
  if (n.nullifier !== undefined && !field(n.nullifier)) return "nullifier must be a field element";
  return null;
}

/** Root reached from `leaf` at `index` along `path` (the pool's hashing). */
export function rootFromPath(leaf: bigint, index: number, path: readonly bigint[]): bigint {
  let node = leaf;
  for (let d = 0; d < TREE_DEPTH; d++) node = (index >> d) & 1 ? hashNode(path[d]!, node) : hashNode(node, path[d]!);
  return node;
}

/** The last RootUpdated at or before `toBlock`, scanning backwards in chunks down to `floor`. */
async function rootAt(pub: PublicClient, pool: Address, toBlock: bigint, floor: bigint, chunk: bigint) {
  for (let hi = toBlock; hi >= floor; hi -= chunk) {
    const lo = hi - chunk + 1n > floor ? hi - chunk + 1n : floor;
    const logs = await logsChunked(pub, { address: pool, event: rootUpdatedEvent as AbiEvent }, lo, hi, chunk);
    const last = logs.at(-1);
    if (last) return { root: BigInt(last.args.root), block: last.blockNumber };
    if (lo === floor) break;
  }
  return null;
}

/**
 * Where verifyDisclosure reads the pool's history. The default scans the chain per call (one pass for the root, one
 * pass for ALL disclosed nullifiers, never one per note); a long-running verifier (the API) passes a cached,
 * incremental index instead, so a request costs no historical RPC scan at all (audit L-15).
 */
export type DisclosureLookup = {
  /** The last RootUpdated at or before `toBlock`. */
  rootAt(toBlock: bigint): Promise<{ root: bigint; block: bigint } | null>;
  /** The first NullifierSpent block (up to `head`) of each nullifier that was spent, keyed by lower-case hex word. */
  spentBlocks(nullifiers: Hex[], head: bigint): Promise<Map<string, bigint>>;
};

/** The default DisclosureLookup: scans `pub` from `floor` in `chunk`-block ranges. */
export function chainLookup(pub: PublicClient, pool: Address, floor: bigint, chunk: bigint): DisclosureLookup {
  return {
    rootAt: (toBlock) => rootAt(pub, pool, toBlock, floor, chunk),
    spentBlocks: async (nullifiers, head) => {
      const out = new Map<string, bigint>();
      const uniq = [...new Set(nullifiers.map((n) => n.toLowerCase() as Hex))];
      for (let i = 0; i < uniq.length; i += NULLIFIER_BATCH) {
        const logs = await logsChunked(pub, { address: pool, event: nullifierSpentEvent as AbiEvent, args: { nullifier: uniq.slice(i, i + NULLIFIER_BATCH) } }, floor, head, chunk);
        for (const l of logs) {
          const k = String(l.args.nullifier).toLowerCase();
          if (!out.has(k)) out.set(k, l.blockNumber);
        }
      }
      return out;
    },
  };
}

/**
 * Verifies a bundle against the chain `pub` is connected to. Stateless; needs only public data.
 * opts.deployBlock bounds the backwards scans (default 0); opts.pool pins the expected pool; opts.maxNotes lowers the
 * note cap; opts.lookup replaces the per-call chain scans with a cached index.
 */
export async function verifyDisclosure(
  pub: PublicClient,
  bundle: unknown,
  opts: { deployBlock?: bigint; pool?: Address; chunk?: bigint; maxNotes?: number; lookup?: DisclosureLookup } = {},
): Promise<DisclosureVerdict> {
  const v: DisclosureVerdict = { ok: false, chainId: null, pool: null, period: null, root: null, rootBlock: null, notes: [], totals: [], errors: checkBundleShape(bundle, opts.maxNotes) };
  if (v.errors.length) return v;
  // Commitments and paths are Poseidon2: load it here, so a stateless verifier (the API) needs no setup call.
  await initVault();
  const b = bundle as DisclosureBundle;
  const pool = getAddress(b.pool);
  Object.assign(v, { chainId: b.chainId, pool, period: b.period, root: b.root });
  const chainId = await pub.getChainId();
  if (chainId !== b.chainId) v.errors.push(`bundle is for chain ${b.chainId}, verifier is on ${chainId}`);
  if (opts.pool && getAddress(opts.pool) !== pool) v.errors.push("bundle names a different pool");
  const toBlock = BigInt(b.period.toBlock);
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  if (toBlock > head) v.errors.push("period ends after the chain head");
  if (v.errors.length) return v;

  const floor = opts.deployBlock ?? 0n;
  const chunk = opts.chunk ?? 50_000n;
  const lookup = opts.lookup ?? chainLookup(pub, pool, floor, chunk);
  const r = await lookup.rootAt(toBlock);
  if (!r) v.errors.push("pool published no root by period end");
  else {
    v.rootBlock = r.block.toString();
    if (r.root !== BigInt(b.root)) v.errors.push("root is not the pool's root at period end");
  }

  const seen = new Set<number>();
  const withNullifier: { nv: NoteVerdict; nullifier: Hex }[] = [];
  for (const n of b.notes as Partial<DisclosedNote>[]) {
    const nv: NoteVerdict = { ok: false, leafIndex: n?.leafIndex ?? -1, asset: null, raw: String(n?.raw ?? ""), commitment: null, nullifierStatus: "not-disclosed", spentBlock: null, error: noteShape(n) };
    v.notes.push(nv);
    if (nv.error) continue;
    nv.asset = getAddress(n.asset!);
    if (seen.has(n.leafIndex!)) {
      nv.error = "leaf disclosed twice";
      continue;
    }
    seen.add(n.leafIndex!);
    const c = commitmentOf(BigInt(nv.asset), BigInt(n.raw!), BigInt(n.ownerPk!), BigInt(n.blinding!));
    nv.commitment = toBytes32(c);
    if (rootFromPath(c, n.leafIndex!, n.path!.map((p) => BigInt(p))) !== BigInt(b.root)) {
      nv.error = "commitment is not in the pool's tree at this leaf";
      continue;
    }
    if (n.nullifier) withNullifier.push({ nv, nullifier: n.nullifier });
    nv.ok = r !== null && r.root === BigInt(b.root);
  }
  // One lookup for every disclosed nullifier (it used to be a full history scan per note).
  if (withNullifier.length) {
    const spent = await lookup.spentBlocks(
      withNullifier.map((x) => x.nullifier),
      head,
    );
    for (const { nv, nullifier } of withNullifier) {
      const at = spent.get(nullifier.toLowerCase());
      if (at !== undefined) {
        nv.spentBlock = at.toString();
        nv.nullifierStatus = at <= toBlock ? "spent" : "spent-after-period";
      } else nv.nullifierStatus = "unspent";
    }
  }

  const totals = new Map<Address, bigint>();
  for (const nv of v.notes) if (nv.ok && nv.nullifierStatus !== "spent") totals.set(nv.asset!, (totals.get(nv.asset!) ?? 0n) + BigInt(nv.raw));
  v.totals = [...totals].map(([asset, raw]) => ({ asset, raw: raw.toString() }));
  v.ok = v.errors.length === 0 && v.notes.every((n) => n.ok);
  return v;
}
