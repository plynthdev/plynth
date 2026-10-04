// ShieldedPool history with block positions: what statements and disclosure checks read from the chain.
// Same events as vault/sync.ts, but every entry keeps (blockNumber, logIndex, txHash) so a statement can
// say when a note arrived or was spent and cut the history at any block.
import type { AbiEvent, Address, Hex, PublicClient } from "viem";
import { depositQueuedEvent, leafInsertedEvent, noteEncryptedEvent, nullifierSpentEvent } from "../vault/abi";
import { parseAbiItem } from "viem";

export const pendingRefundedEvent = parseAbiItem("event PendingRefunded(uint256 indexed pendingId, address indexed origin, uint256 raw)");
export const rootUpdatedEvent = parseAbiItem("event RootUpdated(bytes32 root, uint256 nextLeaf)");

export type Pos = { block: bigint; logIndex: number; txHash: Hex };

export type PoolHistory = {
  pool: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** In leaf order. */
  leaves: ({ index: number; commitment: bigint } & Pos)[];
  encrypted: ({ commitment: bigint; data: Hex } & Pos)[];
  nullifiers: Map<bigint, Pos>;
  deposits: Map<bigint, { pendingId: bigint; origin: Address; raw: bigint; asset: Address } & Pos>;
  refunds: Map<bigint, Pos>;
};

type Log = { blockNumber: bigint; logIndex: number; transactionHash: Hex; args: any };

/** getLogs in block chunks with backoff (public RPCs cap ranges and rate-limit). */
export async function logsChunked(
  pub: PublicClient,
  params: { address: Address; event: AbiEvent; args?: Record<string, unknown> },
  from: bigint,
  to: bigint,
  chunk = 50_000n,
): Promise<Log[]> {
  const out: Log[] = [];
  for (let a = from; a <= to; a += chunk) {
    const b = a + chunk - 1n < to ? a + chunk - 1n : to;
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...((await pub.getLogs({ ...params, fromBlock: a, toBlock: b } as any)) as unknown as Log[]));
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

const pos = (l: Log): Pos => ({ block: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash });

/** Every pool event in [fromBlock, toBlock]. fromBlock should be the pool's deploy block. */
export async function scanPool(pub: PublicClient, pool: Address, fromBlock: bigint, toBlock: bigint, chunk?: bigint): Promise<PoolHistory> {
  const q = (event: AbiEvent) => logsChunked(pub, { address: pool, event }, fromBlock, toBlock, chunk);
  const [leaves, notes, nulls, deps, refunds] = await Promise.all([
    q(leafInsertedEvent as AbiEvent),
    q(noteEncryptedEvent as AbiEvent),
    q(nullifierSpentEvent as AbiEvent),
    q(depositQueuedEvent as AbiEvent),
    q(pendingRefundedEvent as AbiEvent),
  ]);
  const h: PoolHistory = { pool, fromBlock, toBlock, leaves: [], encrypted: [], nullifiers: new Map(), deposits: new Map(), refunds: new Map() };
  for (const l of leaves) {
    const index = Number(l.args.leafIndex);
    if (index !== h.leaves.length) throw new Error(`leaf ${index} out of order (have ${h.leaves.length}); scan from the pool's deploy block`);
    h.leaves.push({ index, commitment: BigInt(l.args.commitment), ...pos(l) });
  }
  for (const l of notes) h.encrypted.push({ commitment: BigInt(l.args.commitment), data: l.args.encryptedNote, ...pos(l) });
  for (const l of nulls) h.nullifiers.set(BigInt(l.args.nullifier), pos(l));
  const byPending = new Map<bigint, bigint>();
  for (const l of deps) {
    const c = BigInt(l.args.commitment);
    byPending.set(BigInt(l.args.pendingId), c);
    h.deposits.set(c, { pendingId: BigInt(l.args.pendingId), origin: l.args.origin, raw: BigInt(l.args.raw), asset: l.args.asset, ...pos(l) });
  }
  for (const l of refunds) {
    const c = byPending.get(BigInt(l.args.pendingId));
    if (c !== undefined) h.refunds.set(c, pos(l));
  }
  return h;
}

/** True when `p` happened at or before block `b`. */
export const atOrBefore = (p: Pos | undefined, b: bigint) => p !== undefined && p.block <= b;
