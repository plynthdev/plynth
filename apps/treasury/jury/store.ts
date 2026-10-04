// jury_verdicts: one row per deliberated exception. Only the treasury service writes it.
import { and, desc, eq, gt } from "drizzle-orm";
import { juryVerdicts, type Db } from "@plynth/db";
import type { JuryBundle } from "./types";

export type JuryRow = typeof juryVerdicts.$inferSelect;

export interface JuryStore {
  insert(b: JuryBundle, json: string, hash: string): Promise<number>;
  markRequested(id: number, ticket: string, txHash: string): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
  byHash(chainId: number, approvals: string, hash: string): Promise<JuryRow | undefined>;
  byTicket(chainId: number, approvals: string, ticket: string): Promise<JuryRow | undefined>;
  /** A ticket already requested for this opHash since `since` (dedupe across desk passes). */
  requestedSince(opHash: string, since: Date): Promise<JuryRow | undefined>;
  recent(limit: number, account?: string): Promise<JuryRow[]>;
}

const lc = (s: string) => s.toLowerCase();

export class PgJuryStore implements JuryStore {
  constructor(private readonly db: Db) {}

  async insert(b: JuryBundle, json: string, hash: string): Promise<number> {
    const r = b.request;
    const [row] = await this.db
      .insert(juryVerdicts)
      .values({
        chainId: r.chainId,
        approvals: lc(r.approvals),
        account: lc(r.account),
        desk: r.desk,
        opHash: lc(r.opHash),
        bundleHash: lc(hash),
        bundleJson: json,
        mode: b.mode,
        recommendation: b.verdict.recommend,
        ruleRecommendation: b.rules.recommend,
        status: "deliberated",
      })
      .onConflictDoUpdate({ target: [juryVerdicts.chainId, juryVerdicts.approvals, juryVerdicts.bundleHash], set: { error: null } })
      .returning({ id: juryVerdicts.id });
    return row!.id;
  }

  async markRequested(id: number, ticket: string, txHash: string) {
    await this.db.update(juryVerdicts).set({ status: "requested", ticket: lc(ticket), txHash: lc(txHash), error: null }).where(eq(juryVerdicts.id, id));
  }

  async markFailed(id: number, error: string) {
    await this.db.update(juryVerdicts).set({ status: "failed", error }).where(eq(juryVerdicts.id, id));
  }

  async byHash(chainId: number, approvals: string, hash: string) {
    const rows = await this.db
      .select()
      .from(juryVerdicts)
      .where(and(eq(juryVerdicts.chainId, chainId), eq(juryVerdicts.approvals, lc(approvals)), eq(juryVerdicts.bundleHash, lc(hash))))
      .limit(1);
    return rows[0];
  }

  async byTicket(chainId: number, approvals: string, ticket: string) {
    const rows = await this.db
      .select()
      .from(juryVerdicts)
      .where(and(eq(juryVerdicts.chainId, chainId), eq(juryVerdicts.approvals, lc(approvals)), eq(juryVerdicts.ticket, lc(ticket))))
      .limit(1);
    return rows[0];
  }

  async requestedSince(opHash: string, since: Date) {
    const rows = await this.db
      .select()
      .from(juryVerdicts)
      .where(and(eq(juryVerdicts.opHash, lc(opHash)), eq(juryVerdicts.status, "requested"), gt(juryVerdicts.createdAt, since)))
      .limit(1);
    return rows[0];
  }

  async recent(limit: number, account?: string) {
    const q = this.db.select().from(juryVerdicts);
    const filtered = account ? q.where(eq(juryVerdicts.account, lc(account))) : q;
    return filtered.orderBy(desc(juryVerdicts.id)).limit(limit);
  }
}
