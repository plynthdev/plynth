// Reads over the indexer's ev_logs. The keeper never trusts these alone for money decisions: every
// action is pre-simulated against the chain, and the contracts enforce the real rules.
import type { Db } from "@plynth/db";
import { sql } from "drizzle-orm";
import { getAddress, toEventSelector, type Address } from "viem";

export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

/** Every address that has ever acted as a user on the vault (settings, deposit, link, mix, accrual). */
export async function knownUsers(db: Db, chainId: number, vault: Address): Promise<Address[]> {
  const rows = (await db.execute(sql`
    select distinct lower(data_json->'args'->>'user') as u from ev_logs
    where chain_id = ${chainId} and address = ${vault.toLowerCase()}
      and data_json->>'eventName' in ('SettingsSet', 'Deposited', 'WalletLinked', 'MixSet', 'Accrued', 'Refunded')
    order by 1`)) as unknown as { u: string | null }[];
  return rows.filter((r) => r.u).map((r) => getAddress(r.u!));
}

export type SpendLog = { txHash: `0x${string}`; logIndex: number; blockNumber: bigint; from: string; to: string; value: bigint; indexedAt?: Date };

/**
 * USDG transfers out of `wallets` that the keeper has not finished with (no done/skipped row yet),
 * oldest first.
 */
export async function openSpends(db: Db, chainId: number, usdg: Address, wallets: string[], limit = 500): Promise<SpendLog[]> {
  if (!wallets.length) return [];
  const lw = wallets.map((w) => w.toLowerCase());
  const rows = (await db.execute(sql`
    select l.tx_hash, l.log_index, l.block_number, lower(l.data_json->'args'->>'from') as "from",
           lower(l.data_json->'args'->>'to') as "to", l.data_json->'args'->>'value' as value, l.created_at
    from ev_logs l
    where l.chain_id = ${chainId} and l.address = ${usdg.toLowerCase()} and l.topic0 = ${TRANSFER_TOPIC}
      and lower(l.data_json->'args'->>'from') in ${sql`(${sql.join(lw.map((w) => sql`${w}`), sql`, `)})`}
      and not exists (
        select 1 from keeper_roundups r
        where r.chain_id = l.chain_id and r.tx_hash = l.tx_hash and r.log_index = l.log_index and r.status in ('done', 'skipped'))
    order by l.block_number, l.log_index
    limit ${limit}`)) as unknown as { tx_hash: string; log_index: number; block_number: string; from: string; to: string; value: string; created_at: Date | string | null }[];
  return rows.map((r) => ({
    txHash: r.tx_hash as `0x${string}`,
    logIndex: Number(r.log_index),
    blockNumber: BigInt(r.block_number),
    from: r.from,
    to: r.to,
    value: BigInt(r.value),
    indexedAt: r.created_at ? new Date(r.created_at) : undefined,
  }));
}
