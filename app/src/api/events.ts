// Reads of the indexer's ev_logs (never written here). Events are matched by contract address + eventName.
import type { Db } from "@/db";
import { sql } from "drizzle-orm";

export type EvRow = { blockNumber: bigint; logIndex: number; txHash: string; address: string; eventName: string; args: Record<string, string> };

type Q = { chainId: number; addresses: string[]; events: string[]; user?: string | undefined; asset?: string | undefined; before?: { block: bigint; logIndex: number } | undefined; limit?: number | undefined; desc?: boolean | undefined };

export async function userEvents(db: Db, q: Q): Promise<EvRow[]> {
  const addrs = q.addresses.map((a) => a.toLowerCase());
  const conds = [
    sql`chain_id = ${q.chainId}`,
    sql`address in ${addrs}`,
    sql`data_json->>'eventName' in ${q.events}`,
  ];
  if (q.user) conds.push(sql`lower(data_json->'args'->>'user') = ${q.user.toLowerCase()}`);
  if (q.asset) conds.push(sql`lower(data_json->'args'->>'asset') = ${q.asset.toLowerCase()}`);
  if (q.before) conds.push(sql`(block_number, log_index) < (${q.before.block.toString()}::bigint, ${q.before.logIndex})`);
  const order = q.desc ? sql`order by block_number desc, log_index desc` : sql`order by block_number asc, log_index asc`;
  const limit = q.limit ? sql`limit ${q.limit}` : sql``;
  const rows = (await db.execute(
    sql`select block_number, log_index, tx_hash, address, data_json from ev_logs where ${sql.join(conds, sql` and `)} ${order} ${limit}`,
  )) as unknown as { block_number: string; log_index: number; tx_hash: string; address: string; data_json: { eventName: string; args: Record<string, string> } }[];
  return rows.map((r) => ({
    blockNumber: BigInt(r.block_number),
    logIndex: r.log_index,
    txHash: r.tx_hash,
    address: r.address,
    eventName: r.data_json.eventName,
    args: r.data_json.args ?? {},
  }));
}

/** Lowest indexed block across the cursors of this chain (null if the indexer never ran). */
export async function indexedBlock(db: Db, chainId: number): Promise<bigint | null> {
  const rows = (await db.execute(sql`select min(last_block)::text as b from ev_cursors where chain_id = ${chainId}`)) as unknown as { b: string | null }[];
  return rows[0]?.b ? BigInt(rows[0].b) : null;
}
