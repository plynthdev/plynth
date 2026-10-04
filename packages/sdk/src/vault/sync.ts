// Local state from ShieldedPool events: the commitment tree, every encrypted note, spent nullifiers.
// Then `myNotes` trial-decrypts with the viewing key and keeps notes whose commitment matches the user's ownerPk.
import type { AbiEvent, Address, Hex, PublicClient } from "viem";
import { leafInsertedEvent, noteEncryptedEvent, nullifierSpentEvent } from "./abi";
import { decryptNote } from "./ecies";
import type { VaultKeys } from "./keys";
import { commitmentOf, nullifierOf, type Note } from "./note";
import { NoteTree } from "./tree";

export type PoolState = {
  tree: NoteTree;
  /** commitment -> leaf index */
  leafOf: Map<bigint, number>;
  encrypted: { commitment: bigint; data: Hex }[];
  spent: Set<bigint>;
  toBlock: bigint;
};

export type OwnedNote = Note & {
  commitment: bigint;
  /** null while the deposit is still pending (not in the tree yet) */
  leafIndex: number | null;
  nullifier: bigint | null;
  spent: boolean;
};

export function emptyState(): PoolState {
  return { tree: new NoteTree(), leafOf: new Map(), encrypted: [], spent: new Set(), toBlock: -1n };
}

async function logsChunked(pub: PublicClient, address: Address, event: AbiEvent, from: bigint, to: bigint, chunk: bigint) {
  const out: any[] = [];
  for (let a = from; a <= to; a += chunk) {
    const b = a + chunk - 1n < to ? a + chunk - 1n : to;
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await pub.getLogs({ address, event, fromBlock: a, toBlock: b } as any)));
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return out;
}

const order = (l: { blockNumber: bigint; logIndex: number }) => l.blockNumber * 1_000_000n + BigInt(l.logIndex);

/** Applies events in (fromBlock = state.toBlock + 1 .. toBlock]. Leaves must arrive in index order. */
export async function syncPool(
  pub: PublicClient,
  pool: Address,
  state: PoolState = emptyState(),
  opts: { fromBlock?: bigint; toBlock?: bigint; chunk?: bigint } = {},
): Promise<PoolState> {
  const from = state.toBlock >= 0n ? state.toBlock + 1n : (opts.fromBlock ?? 0n);
  const to = opts.toBlock ?? (await pub.getBlockNumber({ cacheTime: 0 })); // viem caches the head for 4s otherwise
  if (from > to) return state;
  const chunk = opts.chunk ?? 50_000n;
  const [leaves, notes, nulls] = await Promise.all([
    logsChunked(pub, pool, leafInsertedEvent as AbiEvent, from, to, chunk),
    logsChunked(pub, pool, noteEncryptedEvent as AbiEvent, from, to, chunk),
    logsChunked(pub, pool, nullifierSpentEvent as AbiEvent, from, to, chunk),
  ]);
  leaves.sort((x, y) => (order(x) < order(y) ? -1 : 1));
  for (const l of leaves) {
    const idx = Number(l.args.leafIndex);
    if (idx !== state.tree.size) throw new Error(`leaf ${idx} out of order (have ${state.tree.size})`);
    const c = BigInt(l.args.commitment);
    state.tree.insert(c);
    state.leafOf.set(c, idx);
  }
  for (const l of notes) state.encrypted.push({ commitment: BigInt(l.args.commitment), data: l.args.encryptedNote });
  for (const l of nulls) state.spent.add(BigInt(l.args.nullifier));
  state.toBlock = to;
  return state;
}

/** Notes in `state` that belong to `keys` (decrypt with the viewing key, then match the commitment). */
export function myNotes(state: PoolState, keys: VaultKeys): OwnedNote[] {
  const out: OwnedNote[] = [];
  const seen = new Set<bigint>();
  for (const { commitment, data } of state.encrypted) {
    if (seen.has(commitment)) continue;
    const p = decryptNote(data, keys.viewingSecret);
    if (!p) continue;
    if (commitmentOf(BigInt(p.asset), p.raw, keys.ownerPk, p.blinding) !== commitment) continue;
    seen.add(commitment);
    const idx = state.leafOf.get(commitment);
    const nullifier = idx === undefined ? null : nullifierOf(commitment, keys.spendingSecret, BigInt(idx));
    out.push({
      ...p,
      ownerPk: keys.ownerPk,
      commitment,
      leafIndex: idx ?? null,
      nullifier,
      spent: nullifier !== null && state.spent.has(nullifier),
    });
  }
  return out;
}

/** Spendable balance per asset (inserted, unspent notes). */
export function balances(notes: OwnedNote[]): Map<Address, bigint> {
  const m = new Map<Address, bigint>();
  for (const n of notes) if (n.leafIndex !== null && !n.spent) m.set(n.asset, (m.get(n.asset) ?? 0n) + n.raw);
  return m;
}
