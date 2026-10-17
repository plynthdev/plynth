import { evCursors, evLogs, type Db } from "@/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Hash, PublicClient } from "viem";
import { ChunkSizer, type ChunkOptions } from "./chunk";
import type { Stream } from "./handlers/streams";
import { toJsonSafe } from "./json";
import { backoffDelay, isBackoffError, sleep as realSleep, withRetry, type BackoffOptions } from "./retry";

export const REORG_REWIND = 64n;

export type IndexerOptions = {
  client: PublicClient;
  db: Db;
  chainId: number;
  streams: Stream[];
  /** Blocks behind head treated as final. 12 on public networks, 0 on local anvil. */
  confirmations: bigint;
  chunk?: Partial<ChunkOptions>;
  backoff?: Partial<BackoffOptions> & { maxAttempts?: number };
  /** Consecutive range errors at the minimum chunk size before a pass gives up on a stream. */
  maxRangeFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

export type Cursor = { lastBlock: bigint; lastBlockHash: string | null };
export type PassResult = { stream: string; fromBlock: bigint; toBlock: bigint; logs: number; reorgs: number };

const INSERT_BATCH = 1_000;

export class Indexer {
  readonly sizers = new Map<string, ChunkSizer>();
  private readonly o: Required<Omit<IndexerOptions, "chunk" | "backoff">> & Pick<IndexerOptions, "chunk">;
  private readonly bo: BackoffOptions & { maxAttempts: number };

  constructor(opts: IndexerOptions) {
    this.o = { maxRangeFailures: 6, sleep: realSleep, log: () => {}, ...opts };
    this.bo = { baseMs: 500, maxMs: 30_000, maxAttempts: 8, ...opts.backoff };
    for (const s of opts.streams) this.sizers.set(s.name, new ChunkSizer(opts.chunk));
  }

  /** RPC call with backoff + jitter on 429/5xx. */
  private rpc<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { ...this.bo, sleep: this.o.sleep });
  }

  async safeHead(): Promise<bigint> {
    const head = await this.rpc(() => this.o.client.getBlockNumber({ cacheTime: 0 }));
    const safe = head - this.o.confirmations;
    return safe < 0n ? 0n : safe;
  }

  /** One pass: every stream catches up to head - confirmations. */
  async runOnce(): Promise<PassResult[]> {
    const head = await this.safeHead();
    const out: PassResult[] = [];
    for (const s of this.o.streams) out.push(await this.syncStream(s, head));
    return out;
  }

  async cursor(stream: Stream): Promise<Cursor> {
    const [row] = await this.o.db.select().from(evCursors).where(eq(evCursors.stream, stream.name));
    const init = { lastBlock: stream.fromBlock - 1n, lastBlockHash: null };
    if (row && row.contract === stream.address.toLowerCase()) return { lastBlock: row.lastBlock, lastBlockHash: row.lastBlockHash };
    if (row) {
      // A redeploy (mainnet v1 -> v2) keeps the stream name but moves the contract: the old cursor sits past the new
      // contract's deploy block and would skip its first events. Start the new contract from its own fromBlock.
      this.o.log?.(`indexer: ${stream.name} moved from ${row.contract} to ${stream.address.toLowerCase()}: cursor reset to ${init.lastBlock}`);
      await this.o.db
        .update(evCursors)
        .set({ contract: stream.address.toLowerCase(), lastBlock: init.lastBlock, lastBlockHash: null })
        .where(eq(evCursors.stream, stream.name));
      return init;
    }
    await this.o.db
      .insert(evCursors)
      .values({ stream: stream.name, chainId: this.o.chainId, contract: stream.address.toLowerCase(), lastBlock: init.lastBlock, lastBlockHash: null })
      .onConflictDoNothing();
    return init;
  }

  private async blockHash(n: bigint): Promise<Hash | null> {
    if (n < 0n) return null;
    try {
      const b = await this.rpc(() => this.o.client.getBlock({ blockNumber: n, includeTransactions: false }));
      return b?.hash ?? null;
    } catch (err) {
      if (/not found|could not be found/i.test(String((err as Error)?.message))) return null;
      throw err;
    }
  }

  async syncStream(stream: Stream, head: bigint): Promise<PassResult> {
    const sizer = this.sizers.get(stream.name)!;
    let cur = await this.cursor(stream);
    const res: PassResult = { stream: stream.name, fromBlock: cur.lastBlock + 1n, toBlock: cur.lastBlock, logs: 0, reorgs: 0 };
    let backoffs = 0;
    let minFailures = 0;

    for (;;) {
      // Reorg check before every batch: the block we stopped at must still be the block we saw.
      if (cur.lastBlockHash && cur.lastBlock >= 0n) {
        const now = await this.blockHash(cur.lastBlock);
        if (now?.toLowerCase() !== cur.lastBlockHash.toLowerCase()) {
          this.o.log(`${stream.name}: reorg at ${cur.lastBlock} (stored ${cur.lastBlockHash}, now ${now})`);
          await this.rewind(cur.lastBlock - REORG_REWIND);
          res.reorgs++;
          cur = await this.cursor(stream);
          continue;
        }
      }
      if (cur.lastBlock >= head) break;

      const from = cur.lastBlock + 1n;
      const span = BigInt(sizer.current);
      const to = from + span - 1n < head ? from + span - 1n : head;

      // Hash first, logs second: if a reorg lands in between, the stored hash is the stale one and the
      // next batch's check catches it (the other order would silently pair old logs with a new hash).
      const toHash = await this.blockHash(to);
      if (!toHash) break; // head moved backwards (reorg in progress); try next pass

      let logs;
      try {
        logs = await this.fetchLogs(stream, from, to);
      } catch (err) {
        if (isBackoffError(err)) {
          // Rate limit / server error: same range, wait with jitter.
          if (++backoffs >= this.bo.maxAttempts) throw err;
          await this.o.sleep(backoffDelay(backoffs - 1, this.bo));
        } else if (!sizer.fail()) {
          // Range error at the minimum chunk: retry a few times, then give up on this pass.
          if (++minFailures >= this.o.maxRangeFailures) throw err;
          await this.o.sleep(backoffDelay(minFailures - 1, this.bo));
        }
        continue;
      }
      backoffs = 0;
      minFailures = 0;
      sizer.success();

      const rows = logs
        .filter((l: any) => !l.removed && l.blockNumber !== null && l.transactionHash)
        .map((l: any) => ({
          chainId: this.o.chainId,
          blockNumber: l.blockNumber as bigint,
          blockHash: (l.blockHash as string).toLowerCase(),
          txHash: (l.transactionHash as string).toLowerCase(),
          logIndex: Number(l.logIndex),
          address: (l.address as string).toLowerCase(),
          topic0: l.topics?.[0]?.toLowerCase() ?? null,
          dataJson: toJsonSafe({ eventName: l.eventName ?? null, args: l.args ?? null, topics: l.topics, data: l.data }) as object,
        }));

      await this.o.db.transaction(async (tx) => {
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          await tx.insert(evLogs).values(rows.slice(i, i + INSERT_BATCH)).onConflictDoNothing();
        }
        await tx
          .insert(evCursors)
          .values({ stream: stream.name, chainId: this.o.chainId, contract: stream.address.toLowerCase(), lastBlock: to, lastBlockHash: toHash.toLowerCase() })
          .onConflictDoUpdate({ target: evCursors.stream, set: { lastBlock: to, lastBlockHash: toHash.toLowerCase(), updatedAt: sql`now()` } });
      });

      res.logs += rows.length;
      res.toBlock = to;
      cur = { lastBlock: to, lastBlockHash: toHash.toLowerCase() };
    }
    return res;
  }

  private fetchLogs(stream: Stream, fromBlock: bigint, toBlock: bigint) {
    const c = this.o.client;
    if (stream.events.length === 1) {
      return c.getLogs({ address: stream.address, event: stream.events[0]!, args: stream.args as any, fromBlock, toBlock, strict: false });
    }
    return c.getLogs({ address: stream.address, events: stream.events, fromBlock, toBlock, strict: false });
  }

  /**
   * Reorg rewind, chain-wide: delete every ev_* row above `target` and pull every cursor on this chain back
   * to at most `target`, all in one transaction. Chain-wide because streams share ev_logs.
   */
  async rewind(target: bigint): Promise<void> {
    const t = target < -1n ? -1n : target;
    const hash = await this.blockHash(t);
    const tables = await evTablesWithBlocks(this.o.db);
    const byName = new Map(this.o.streams.map((s) => [s.name, s]));
    await this.o.db.transaction(async (tx) => {
      for (const table of tables) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where chain_id = ${this.o.chainId} and block_number > ${t}`);
      }
      const cursors = await tx.select().from(evCursors).where(and(eq(evCursors.chainId, this.o.chainId), gt(evCursors.lastBlock, t)));
      for (const c of cursors) {
        const s = byName.get(c.stream);
        const floor = s ? s.fromBlock - 1n : -1n;
        const last = t > floor ? t : floor;
        await tx
          .update(evCursors)
          .set({ lastBlock: last, lastBlockHash: last === t ? (hash?.toLowerCase() ?? null) : null, updatedAt: sql`now()` })
          .where(eq(evCursors.stream, c.stream));
      }
    });
  }
}

/** Every indexer-owned table that holds block-scoped rows (ev_logs now; ev_<contract>_<event> later). */
export async function evTablesWithBlocks(db: Db): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    select c.table_name from information_schema.columns c
    where c.table_schema = current_schema() and c.table_name like 'ev\_%' and c.column_name in ('chain_id', 'block_number')
    group by c.table_name having count(*) = 2 order by c.table_name`);
  return (rows as unknown as { table_name: string }[]).map((r) => r.table_name);
}
