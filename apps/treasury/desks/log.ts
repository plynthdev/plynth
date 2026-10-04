import { and, eq } from "drizzle-orm";
import { deskActions, type Db } from "@plynth/db";

export type ActionRow = {
  chainId: number;
  account: string;
  desk: "cash" | "equity";
  action: string;
  status: "sent" | "rejected" | "reverted" | "skipped" | "done";
  reasonCode?: number | null;
  reason?: string | null;
  adapter?: string | null;
  asset?: string | null;
  amount?: bigint | null;
  notionalUsd?: bigint | null;
  beaconKey?: string | null;
  txHash?: string | null;
  blockNumber?: bigint | null;
  detail?: unknown;
};

/** Where desks record what they did. Postgres in production (desk_actions); memory in unit tests. */
export interface ActionLog {
  record(row: ActionRow): Promise<void>;
  /** True once a `rebalance_done` marker exists for this beacon key. */
  rebalanceDone(account: string, beaconKey: string): Promise<boolean>;
}

export class MemoryActionLog implements ActionLog {
  rows: ActionRow[] = [];
  async record(row: ActionRow) {
    this.rows.push(row);
  }
  async rebalanceDone(account: string, beaconKey: string) {
    return this.rows.some((r) => r.action === "rebalance_done" && r.beaconKey === beaconKey && r.account.toLowerCase() === account.toLowerCase());
  }
}

export class PgActionLog implements ActionLog {
  constructor(private readonly db: Db) {}
  async record(r: ActionRow) {
    await this.db.insert(deskActions).values({
      chainId: r.chainId,
      account: r.account.toLowerCase(),
      desk: r.desk,
      action: r.action,
      status: r.status,
      reasonCode: r.reasonCode ?? null,
      reason: r.reason ?? null,
      adapter: r.adapter?.toLowerCase() ?? null,
      asset: r.asset?.toLowerCase() ?? null,
      amount: r.amount === undefined || r.amount === null ? null : r.amount.toString(),
      notionalUsd: r.notionalUsd === undefined || r.notionalUsd === null ? null : r.notionalUsd.toString(),
      beaconKey: r.beaconKey ?? null,
      txHash: r.txHash ?? null,
      blockNumber: r.blockNumber ?? null,
      detail: r.detail === undefined ? null : JSON.parse(JSON.stringify(r.detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    });
  }
  async rebalanceDone(account: string, beaconKey: string) {
    const rows = await this.db
      .select({ id: deskActions.id })
      .from(deskActions)
      .where(and(eq(deskActions.account, account.toLowerCase()), eq(deskActions.beaconKey, beaconKey), eq(deskActions.action, "rebalance_done")))
      .limit(1);
    return rows.length > 0;
  }
}
