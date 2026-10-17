// DeskRegistered index for desk.list (review v2, V2-L16 / API-3). The route used to scan the account's whole log
// history on every request: about 7 getLogs today, about 2,500 per request after a year of RHC blocks. Now each account
// is scanned once, in the background and one scan at a time, up to `head - confirmations`; later requests only scan
// the blocks since (plus the unconfirmed tail, which is not stored, so a reorg cannot leave a removed desk behind).
// A request waits a short while for a first scan and otherwise gets "catching up" (503), so no request ever pays for
// more than its share of one scan.
import type { Address, Hex, PublicClient } from "viem";

export const DESK_SCAN_CHUNK = 50_000n;
export const DESK_SCAN_CONFIRMATIONS = 64n;
export const DESK_INDEX_WAIT_MS = 2_000;
export const DESK_INDEX_MAX_ACCOUNTS = 10_000;

export class DeskIndexBehind extends Error {}

export type DeskLogs = (account: Address, fromBlock: bigint, toBlock: bigint) => Promise<Hex[]>;

type Entry = { scannedTo: bigint; ids: Set<Hex>; running?: Promise<void> | undefined };

export class DeskIndex {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly opts: { chunk?: bigint; confirmations?: bigint; waitMs?: number; maxAccounts?: number } = {},
  ) {}

  /** Desk ids ever registered on `account`, scanning from `from`. Throws DeskIndexBehind while the first scan runs. */
  async ids(pub: Pick<PublicClient, "getBlockNumber">, account: Address, from: bigint, logs: DeskLogs): Promise<Hex[]> {
    const k = account.toLowerCase();
    let e = this.entries.get(k);
    if (!e) {
      e = { scannedTo: from - 1n, ids: new Set() };
      this.entries.set(k, e);
      while (this.entries.size > (this.opts.maxAccounts ?? DESK_INDEX_MAX_ACCOUNTS)) this.entries.delete(this.entries.keys().next().value!);
    }
    const head = await pub.getBlockNumber();
    const confirmed = head - (this.opts.confirmations ?? DESK_SCAN_CONFIRMATIONS);
    if (e.scannedTo < confirmed && !e.running) {
      const entry = e;
      entry.running = this.scan(account, entry, confirmed, logs).finally(() => (entry.running = undefined));
    }
    if (e.running) {
      const done = await Promise.race([e.running.then(() => true, () => true), Bun.sleep(this.opts.waitMs ?? DESK_INDEX_WAIT_MS).then(() => false)]);
      if (!done || e.scannedTo < confirmed) throw new DeskIndexBehind("the desk index for this treasury is catching up; retry shortly");
    }
    const tail = confirmed + 1n > from ? confirmed + 1n : from;
    const fresh = tail <= head ? await logs(account, tail, head) : [];
    return [...new Set([...e.ids, ...fresh])];
  }

  private async scan(account: Address, e: Entry, to: bigint, logs: DeskLogs) {
    const chunk = this.opts.chunk ?? DESK_SCAN_CHUNK;
    for (let s = e.scannedTo + 1n; s <= to; s += chunk) {
      const end = s + chunk - 1n < to ? s + chunk - 1n : to;
      for (const id of await logs(account, s, end)) e.ids.add(id);
      e.scannedTo = end; // progress is kept: a failed scan resumes where it stopped
    }
  }
}

/** One index per chain client (in production: one per API process). */
const byClient = new WeakMap<object, DeskIndex>();
export function deskIndexFor(pub: object): DeskIndex {
  let ix = byClient.get(pub);
  if (!ix) byClient.set(pub, (ix = new DeskIndex()));
  return ix;
}
