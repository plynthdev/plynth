// Calendar periods (UTC months) as block ranges, found by binary search on block timestamps.
import type { PublicClient } from "viem";

type Blocks = Pick<PublicClient, "getBlock">;

/** Last block with timestamp <= ts, searching [lo, hi]; null when even `lo` is later than ts. */
export async function blockAtOrBefore(pub: Blocks, ts: bigint, lo: bigint, hi: bigint, cache = new Map<bigint, bigint>()): Promise<bigint | null> {
  const time = async (n: bigint) => {
    let t = cache.get(n);
    if (t === undefined) {
      t = (await pub.getBlock({ blockNumber: n })).timestamp;
      cache.set(n, t);
    }
    return t;
  };
  if ((await time(lo)) > ts) return null;
  if ((await time(hi)) <= ts) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await time(mid)) <= ts) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export type MonthPeriod = { id: string; start: bigint; end: bigint; fromBlock: bigint; toBlock: bigint; complete: boolean };

const monthStart = (y: number, m: number) => BigInt(Date.UTC(y, m, 1) / 1000);

/**
 * UTC months from the month containing `sinceTs` to the month containing the head block, newest first,
 * at most `max`. A month's toBlock is its last block; the running month ends at the head (complete = false).
 * Months with no blocks of their own are skipped.
 */
export async function monthlyPeriods(pub: Blocks, opts: { sinceBlock: bigint; headBlock: bigint; max?: number }): Promise<MonthPeriod[]> {
  const cache = new Map<bigint, bigint>();
  const since = (await pub.getBlock({ blockNumber: opts.sinceBlock })).timestamp;
  const head = (await pub.getBlock({ blockNumber: opts.headBlock })).timestamp;
  cache.set(opts.sinceBlock, since);
  cache.set(opts.headBlock, head);
  const d = new Date(Number(head) * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const out: MonthPeriod[] = [];
  for (let i = 0; i < (opts.max ?? 24); i++) {
    const start = monthStart(y, m);
    const end = monthStart(y, m + 1) - 1n;
    if (end < since) break;
    const toBlock = end >= head ? opts.headBlock : await blockAtOrBefore(pub, end, opts.sinceBlock, opts.headBlock, cache);
    const before = start <= since ? null : await blockAtOrBefore(pub, start - 1n, opts.sinceBlock, opts.headBlock, cache);
    const fromBlock = before === null ? opts.sinceBlock : before + 1n;
    if (toBlock !== null && fromBlock <= toBlock) {
      out.push({ id: `${y}-${String(m + 1).padStart(2, "0")}`, start, end, fromBlock, toBlock, complete: end < head });
    }
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return out;
}
