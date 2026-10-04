// Where breaks and fills live: Postgres in production (exceptions, venue_fills; migration 0006), memory in tests.
import { and, eq, inArray } from "drizzle-orm";
import { exceptions, venueFills, type Db } from "@/db";
import type { Address } from "viem";

export type BreakKind = "reconcile.position" | "reconcile.equity" | "reconcile.stale_mirror" | "reconcile.venue_error";

export type Break = {
  kind: BreakKind;
  key: string; // kind:venue:underlying
  venue: string;
  underlying: Address | null;
  detail: Record<string, unknown>;
};

export type ExceptionRow = Break & {
  id: number;
  status: "open" | "explained" | "resolved";
  explanation: string | null;
  explainedBy: string | null;
};

export interface ExceptionStore {
  /** Inserts an open row for a new break, or bumps last_seen on the open row with the same key. */
  upsertOpen(chainId: number, account: string, b: Break): Promise<{ id: number; isNew: boolean }>;
  /** Open rows of the account. */
  open(chainId: number, account: string): Promise<ExceptionRow[]>;
  /** A human's reason; the row stops blocking the close. */
  explain(id: number, explanation: string, by: string): Promise<void>;
  /** The sources agree again (only for kinds the reconciler is configured to auto-resolve). */
  resolve(id: number): Promise<void>;
}

export interface FillLedger {
  record(chainId: number, account: string, f: { venue: string; underlying: Address; desk: string; tokens: bigint; orderId?: string }): Promise<void>;
  /** Signed position per underlying (lowercase address) at `venue`. */
  positions(chainId: number, account: string, venue: string): Promise<Map<string, bigint>>;
}

const lc = (s: string) => s.toLowerCase();
const jsonSafe = (d: Record<string, unknown>) => JSON.parse(JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;

export class MemoryExceptionStore implements ExceptionStore {
  rows: (ExceptionRow & { chainId: number; account: string })[] = [];

  async upsertOpen(chainId: number, account: string, b: Break) {
    const hit = this.rows.find((r) => r.chainId === chainId && r.account === lc(account) && r.key === b.key && r.status === "open");
    if (hit) {
      hit.detail = jsonSafe(b.detail);
      return { id: hit.id, isNew: false };
    }
    const id = this.rows.length + 1;
    this.rows.push({ ...b, detail: jsonSafe(b.detail), id, chainId, account: lc(account), status: "open", explanation: null, explainedBy: null });
    return { id, isNew: true };
  }

  async open(chainId: number, account: string) {
    return this.rows.filter((r) => r.chainId === chainId && r.account === lc(account) && r.status === "open");
  }

  async explain(id: number, explanation: string, by: string) {
    if (!explanation.trim() || !by.trim()) throw new Error("an explanation needs a reason and a name");
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`no exception ${id}`);
    Object.assign(r, { status: "explained", explanation, explainedBy: by });
  }

  async resolve(id: number) {
    const r = this.rows.find((x) => x.id === id);
    if (r && r.status === "open") r.status = "resolved";
  }
}

export class MemoryLedger implements FillLedger {
  fills: { chainId: number; account: string; venue: string; underlying: string; desk: string; tokens: bigint }[] = [];

  async record(chainId: number, account: string, f: { venue: string; underlying: Address; desk: string; tokens: bigint }) {
    this.fills.push({ chainId, account: lc(account), venue: lc(f.venue), underlying: lc(f.underlying), desk: f.desk, tokens: f.tokens });
  }

  async positions(chainId: number, account: string, venue: string) {
    const out = new Map<string, bigint>();
    for (const f of this.fills) {
      if (f.chainId !== chainId || f.account !== lc(account) || f.venue !== lc(venue)) continue;
      out.set(f.underlying, (out.get(f.underlying) ?? 0n) + f.tokens);
    }
    return out;
  }
}

export class PgExceptionStore implements ExceptionStore {
  constructor(private readonly db: Db) {}

  async upsertOpen(chainId: number, account: string, b: Break) {
    const where = and(eq(exceptions.chainId, chainId), eq(exceptions.account, lc(account)), eq(exceptions.key, b.key), eq(exceptions.status, "open"));
    const [hit] = await this.db.select({ id: exceptions.id }).from(exceptions).where(where).limit(1);
    if (hit) {
      await this.db.update(exceptions).set({ lastSeenAt: new Date(), detail: jsonSafe(b.detail) }).where(eq(exceptions.id, hit.id));
      return { id: hit.id, isNew: false };
    }
    const [row] = await this.db
      .insert(exceptions)
      .values({ chainId, account: lc(account), kind: b.kind, key: b.key, venue: lc(b.venue), underlying: b.underlying ? lc(b.underlying) : null, detail: jsonSafe(b.detail), status: "open" })
      .returning({ id: exceptions.id });
    return { id: row!.id, isNew: true };
  }

  async open(chainId: number, account: string): Promise<ExceptionRow[]> {
    const rows = await this.db.select().from(exceptions).where(and(eq(exceptions.chainId, chainId), eq(exceptions.account, lc(account)), inArray(exceptions.status, ["open"])));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as BreakKind,
      key: r.key,
      venue: r.venue,
      underlying: (r.underlying as Address | null) ?? null,
      detail: r.detail as Record<string, unknown>,
      status: r.status as ExceptionRow["status"],
      explanation: r.explanation,
      explainedBy: r.explainedBy,
    }));
  }

  async explain(id: number, explanation: string, by: string) {
    if (!explanation.trim() || !by.trim()) throw new Error("an explanation needs a reason and a name");
    const r = await this.db.update(exceptions).set({ status: "explained", explanation, explainedBy: by, closedAt: new Date() }).where(eq(exceptions.id, id)).returning({ id: exceptions.id });
    if (!r.length) throw new Error(`no exception ${id}`);
  }

  async resolve(id: number) {
    await this.db.update(exceptions).set({ status: "resolved", closedAt: new Date() }).where(and(eq(exceptions.id, id), eq(exceptions.status, "open")));
  }
}

export class PgLedger implements FillLedger {
  constructor(private readonly db: Db) {}

  async record(chainId: number, account: string, f: { venue: string; underlying: Address; desk: string; tokens: bigint; orderId?: string }) {
    await this.db.insert(venueFills).values({ chainId, account: lc(account), venue: lc(f.venue), underlying: lc(f.underlying), desk: f.desk, tokens: f.tokens.toString(), orderId: f.orderId ?? null });
  }

  async positions(chainId: number, account: string, venue: string) {
    const rows = await this.db
      .select({ underlying: venueFills.underlying, tokens: venueFills.tokens })
      .from(venueFills)
      .where(and(eq(venueFills.chainId, chainId), eq(venueFills.account, lc(account)), eq(venueFills.venue, lc(venue))));
    const out = new Map<string, bigint>();
    for (const r of rows) out.set(r.underlying, (out.get(r.underlying) ?? 0n) + BigInt(r.tokens));
    return out;
  }
}
