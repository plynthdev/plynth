// Where the close service keeps bundles: Postgres `closes` (and reads `desk_actions` for the period's desk
// activity). Only the treasury service writes these tables.
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { closes, deskActions, type Db } from "@/db";
import type { BundleDeskAction, BundleReceipt } from "./bundle";
import { ReceiptStore } from "@/treasury/receipts/store";

export type CloseRow = typeof closes.$inferSelect;

export type NewClose = {
  chainId: number;
  periodClose: string;
  account: string;
  periodEnd: bigint;
  navUsd: bigint;
  bundleHash: string;
  bundleJson: string;
  signature: string;
  lastDeskActionId: number;
};

export class CloseStore {
  constructor(private readonly db: Db) {}

  async insertSigned(c: NewClose): Promise<number> {
    const [row] = await this.db
      .insert(closes)
      .values({ ...c, periodClose: c.periodClose.toLowerCase(), account: c.account.toLowerCase(), navUsd: c.navUsd.toString(), status: "signed" })
      .onConflictDoUpdate({ target: [closes.chainId, closes.periodClose, closes.bundleHash], set: { status: "signed", error: null } })
      .returning({ id: closes.id });
    return row!.id;
  }

  async markCommitted(id: number, r: { txHash: string; blockNumber: bigint; closeIndex: number }) {
    await this.db.update(closes).set({ status: "committed", txHash: r.txHash, blockNumber: r.blockNumber, closeIndex: r.closeIndex, committedAt: new Date(), error: null }).where(eq(closes.id, id));
  }

  async markStatus(id: number, status: "stale" | "failed", error: string) {
    await this.db.update(closes).set({ status, error }).where(eq(closes.id, id));
  }

  /** The last desk_actions id already covered by a committed close of this PeriodClose. */
  async lastCoveredDeskActionId(chainId: number, periodClose: string): Promise<number> {
    const rows = await this.db
      .select({ id: closes.lastDeskActionId })
      .from(closes)
      .where(and(eq(closes.chainId, chainId), eq(closes.periodClose, periodClose.toLowerCase()), eq(closes.status, "committed")))
      .orderBy(desc(closes.periodEnd))
      .limit(1);
    return rows[0]?.id ?? 0;
  }

  async deskActionsSince(chainId: number, account: string, afterId: number): Promise<BundleDeskAction[]> {
    const rows = await this.db
      .select()
      .from(deskActions)
      .where(and(eq(deskActions.chainId, chainId), eq(deskActions.account, account.toLowerCase()), gt(deskActions.id, afterId)))
      .orderBy(asc(deskActions.id));
    return rows.map((r) => ({
      id: r.id,
      desk: r.desk,
      action: r.action,
      status: r.status,
      reasonCode: r.reasonCode,
      reason: r.reason,
      asset: r.asset,
      amount: r.amount,
      notionalUsd: r.notionalUsd,
      txHash: r.txHash,
      at: r.createdAt.toISOString(),
    }));
  }

  /** Hourly receipt roots already posted for hours starting in [fromTs, toTs). */
  async receiptRoots(chainId: number, account: string, fromTs: bigint, toTs: bigint): Promise<BundleReceipt[]> {
    const rows = await new ReceiptStore(this.db).postedBetween(chainId, account, fromTs, toTs);
    return rows.map((r) => ({ hour: r.hour.toString(), root: r.root.toLowerCase(), leafCount: r.leafCount, txHash: r.txHash }));
  }

  async byBundleHash(chainId: number, periodClose: string, bundleHash: string): Promise<CloseRow | undefined> {
    const rows = await this.db
      .select()
      .from(closes)
      .where(and(eq(closes.chainId, chainId), eq(closes.periodClose, periodClose.toLowerCase()), eq(closes.bundleHash, bundleHash.toLowerCase())))
      .limit(1);
    return rows[0];
  }

  /** The committed row for a period end (its block number is where to look for the event). */
  async committedAt(chainId: number, periodClose: string, periodEnd: bigint): Promise<CloseRow | undefined> {
    const rows = await this.db
      .select()
      .from(closes)
      .where(and(eq(closes.chainId, chainId), eq(closes.periodClose, periodClose.toLowerCase()), eq(closes.periodEnd, periodEnd), eq(closes.status, "committed")))
      .limit(1);
    return rows[0];
  }
}
