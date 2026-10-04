import type { Db } from "@/db";
import { sql } from "drizzle-orm";

/** One WalletLinked / WalletUnlinked log from the SavingsVault, in chain order. */
export type LinkEvent = {
  kind: "WalletLinked" | "WalletUnlinked";
  user: string;
  wallet: string;
  blockNumber: bigint;
  logIndex: number;
};

/** A wallet counted as `user`'s spending wallet for blocks in [fromBlock, toBlock) (toBlock null = still linked). */
export type LinkInterval = { user: string; fromBlock: bigint; toBlock: bigint | null };

/**
 * Link history per wallet (lowercase). A re-link to another user closes the previous interval at the
 * re-link block, an unlink closes it at the unlink block. A spend in the link block itself counts: the
 * vault only links when the wallet signs, so a spend in the same block is the wallet owner's.
 */
export function linkIntervals(events: LinkEvent[]): Map<string, LinkInterval[]> {
  const sorted = [...events].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const out = new Map<string, LinkInterval[]>();
  for (const e of sorted) {
    const w = e.wallet.toLowerCase();
    const list = out.get(w) ?? [];
    const open = list.at(-1);
    if (open && open.toBlock === null) open.toBlock = e.blockNumber;
    if (e.kind === "WalletLinked") list.push({ user: e.user.toLowerCase(), fromBlock: e.blockNumber, toBlock: null });
    out.set(w, list);
  }
  // Drop zero-length intervals (link and unlink/re-link in the same block): nothing can be attributed to them.
  for (const [w, list] of out) out.set(w, list.filter((i) => i.toBlock === null || i.toBlock > i.fromBlock));
  return out;
}

/** The user `wallet` was linked to at `blockNumber`, if any. */
export function linkedUserAt(intervals: Map<string, LinkInterval[]>, wallet: string, blockNumber: bigint): string | undefined {
  for (const i of intervals.get(wallet.toLowerCase()) ?? []) {
    if (blockNumber >= i.fromBlock && (i.toBlock === null || blockNumber < i.toBlock)) return i.user;
  }
  return undefined;
}

/** Link events for `vault` already in ev_logs. */
export async function linkEvents(db: Db, chainId: number, vault: string): Promise<LinkEvent[]> {
  const rows = (await db.execute(sql`
    select data_json->>'eventName' as kind, data_json->'args'->>'user' as "user", data_json->'args'->>'wallet' as wallet,
           block_number, log_index
    from ev_logs
    where chain_id = ${chainId} and address = ${vault.toLowerCase()}
      and data_json->>'eventName' in ('WalletLinked', 'WalletUnlinked')
    order by block_number, log_index`)) as unknown as { kind: LinkEvent["kind"]; user: string; wallet: string; block_number: string; log_index: number }[];
  return rows.map((r) => ({ kind: r.kind, user: r.user, wallet: r.wallet, blockNumber: BigInt(r.block_number), logIndex: Number(r.log_index) }));
}

/** Every wallet ever linked, with the block it was first linked (the start of its spend stream). */
export async function linkedWallets(db: Db, chainId: number, vault: string): Promise<{ wallet: string; fromBlock: bigint }[]> {
  const first = new Map<string, bigint>();
  for (const e of await linkEvents(db, chainId, vault)) {
    const w = e.wallet.toLowerCase();
    if (e.kind === "WalletLinked" && !first.has(w)) first.set(w, e.blockNumber);
  }
  return [...first].map(([wallet, fromBlock]) => ({ wallet, fromBlock }));
}
