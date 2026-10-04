// Postgres side of the hourly receipts: reads desk_actions (written by the desks), writes treasury_receipts.
import { deskActions, treasuryReceipts, type Db } from "@/db";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { HOUR, type ActionRow } from "./tree";

export type ReceiptRow = typeof treasuryReceipts.$inferSelect;

export class ReceiptStore {
  constructor(readonly db: Db) {}

  /** Every desk_actions row of `account` created in UTC hour `hour`, ascending id (the leaf order). */
  async actionsInHour(chainId: number, account: string, hour: bigint): Promise<ActionRow[]> {
    const from = new Date(Number(hour) * HOUR * 1000);
    const to = new Date((Number(hour) + 1) * HOUR * 1000);
    return this.db
      .select()
      .from(deskActions)
      .where(and(eq(deskActions.chainId, chainId), eq(deskActions.account, account.toLowerCase()), gte(deskActions.createdAt, from), lt(deskActions.createdAt, to)))
      .orderBy(asc(deskActions.id));
  }

  async actionsByIds(ids: number[]): Promise<ActionRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(deskActions).where(inArray(deskActions.id, ids)).orderBy(asc(deskActions.id));
  }

  async action(chainId: number, id: number): Promise<ActionRow | undefined> {
    const [r] = await this.db.select().from(deskActions).where(and(eq(deskActions.chainId, chainId), eq(deskActions.id, id))).limit(1);
    return r;
  }

  /** Hours (ascending) that have desk actions after hour `afterHour` and before hour `beforeHour`. */
  async hoursWithActions(chainId: number, account: string, afterHour: bigint, beforeHour: bigint): Promise<bigint[]> {
    const from = new Date((Number(afterHour) + 1) * HOUR * 1000);
    const to = new Date(Number(beforeHour) * HOUR * 1000);
    if (to <= from) return [];
    const rows = await this.db
      .selectDistinct({ h: sql<string>`floor(extract(epoch from ${deskActions.createdAt}) / 3600)::bigint` })
      .from(deskActions)
      .where(and(eq(deskActions.chainId, chainId), eq(deskActions.account, account.toLowerCase()), gte(deskActions.createdAt, from), lt(deskActions.createdAt, to)));
    return rows.map((r) => BigInt(r.h)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async get(chainId: number, account: string, hour: bigint): Promise<ReceiptRow | undefined> {
    const [r] = await this.db
      .select()
      .from(treasuryReceipts)
      .where(and(eq(treasuryReceipts.chainId, chainId), eq(treasuryReceipts.account, account.toLowerCase()), eq(treasuryReceipts.hour, hour)))
      .limit(1);
    return r;
  }

  /** The highest hour already built for the account (any status), or null. */
  async lastHour(chainId: number, account: string): Promise<bigint | null> {
    const [r] = await this.db
      .select({ hour: treasuryReceipts.hour })
      .from(treasuryReceipts)
      .where(and(eq(treasuryReceipts.chainId, chainId), eq(treasuryReceipts.account, account.toLowerCase())))
      .orderBy(desc(treasuryReceipts.hour))
      .limit(1);
    return r?.hour ?? null;
  }

  /** Built or failed receipts still to post (oldest first). */
  async unposted(chainId: number, account: string): Promise<ReceiptRow[]> {
    return this.db
      .select()
      .from(treasuryReceipts)
      .where(and(eq(treasuryReceipts.chainId, chainId), eq(treasuryReceipts.account, account.toLowerCase()), inArray(treasuryReceipts.status, ["built", "failed"])))
      .orderBy(asc(treasuryReceipts.hour));
  }

  /** Posted receipts with hour start in [fromTs, toTs) (unix seconds): what a period close bundles. */
  async postedBetween(chainId: number, account: string, fromTs: bigint, toTs: bigint): Promise<ReceiptRow[]> {
    const lo = fromTs / BigInt(HOUR);
    const hi = (toTs + BigInt(HOUR) - 1n) / BigInt(HOUR);
    return this.db
      .select()
      .from(treasuryReceipts)
      .where(
        and(
          eq(treasuryReceipts.chainId, chainId),
          eq(treasuryReceipts.account, account.toLowerCase()),
          eq(treasuryReceipts.status, "posted"),
          gte(treasuryReceipts.hour, lo),
          lt(treasuryReceipts.hour, hi),
        ),
      )
      .orderBy(asc(treasuryReceipts.hour));
  }

  async insertBuilt(r: { chainId: number; account: string; hour: bigint; root: string; leafCount: number; actionIds: number[] }): Promise<ReceiptRow> {
    const [row] = await this.db
      .insert(treasuryReceipts)
      .values({ ...r, account: r.account.toLowerCase(), status: "built" })
      .onConflictDoNothing()
      .returning();
    return row ?? (await this.get(r.chainId, r.account, r.hour))!;
  }

  async markPosted(id: number, txHash: string | null, blockNumber: bigint | null) {
    await this.db.update(treasuryReceipts).set({ status: "posted", txHash, blockNumber, error: null }).where(eq(treasuryReceipts.id, id));
  }

  async markFailed(id: number, error: string) {
    await this.db.update(treasuryReceipts).set({ status: "failed", error }).where(eq(treasuryReceipts.id, id));
  }
}
