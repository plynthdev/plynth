// roundup_sources / roundup_events access. The API inserts (import, link); the keeper syncs and accrues.
import { roundupEvents, roundupSources, type Db } from "@/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Address } from "viem";
import type { ParsedRow } from "./statement";
import type { SourceName, SpendEvent } from "./types";

export type SourceRow = typeof roundupSources.$inferSelect;
export type EventRow = typeof roundupEvents.$inferSelect;
type Base = { db: Db; chainId: number };

const lc = (a: string) => a.toLowerCase();

/** Links (or re-links) a source as active. A new sealed secret replaces the old one; none keeps it. */
export async function upsertSource(b: Base, user: Address, kind: SourceName, sourceKey: string, secretEnc?: string): Promise<void> {
  await b.db
    .insert(roundupSources)
    .values({ chainId: b.chainId, userAddress: lc(user), kind, sourceKey, status: "active", secretEnc: secretEnc ?? null })
    .onConflictDoUpdate({
      target: [roundupSources.chainId, roundupSources.userAddress, roundupSources.kind, roundupSources.sourceKey],
      set: { status: "active", ...(secretEnc ? { secretEnc, cursor: null } : {}), lastError: null, updatedAt: sql`now()` },
    });
}

/** Unlinks: the source stops accruing and its sealed secret is forgotten. Returns the row as it was. */
export async function unlinkSource(b: Base, user: Address, kind: SourceName, sourceKey: string): Promise<SourceRow | undefined> {
  const where = and(eq(roundupSources.chainId, b.chainId), eq(roundupSources.userAddress, lc(user)), eq(roundupSources.kind, kind), eq(roundupSources.sourceKey, sourceKey));
  const [before] = await b.db.select().from(roundupSources).where(where);
  if (before) await b.db.update(roundupSources).set({ status: "unlinked", secretEnc: null, cursor: null, updatedAt: sql`now()` }).where(where);
  return before;
}

export async function activeSources(b: Base, kind?: SourceName, user?: Address): Promise<SourceRow[]> {
  return b.db
    .select()
    .from(roundupSources)
    .where(
      and(
        eq(roundupSources.chainId, b.chainId),
        eq(roundupSources.status, "active"),
        kind ? eq(roundupSources.kind, kind) : undefined,
        user ? eq(roundupSources.userAddress, lc(user)) : undefined,
      ),
    );
}

export async function setSourceSync(b: Base, s: Pick<SourceRow, "userAddress" | "kind" | "sourceKey">, v: { cursor?: string; error?: string | null }) {
  await b.db
    .update(roundupSources)
    .set({ ...(v.cursor !== undefined ? { cursor: v.cursor, lastSyncedAt: sql`now()` } : {}), lastError: v.error ?? null, updatedAt: sql`now()` })
    .where(and(eq(roundupSources.chainId, b.chainId), eq(roundupSources.userAddress, s.userAddress), eq(roundupSources.kind, s.kind), eq(roundupSources.sourceKey, s.sourceKey)));
}

/**
 * Stores new spends; a (user, rowHash) already present is a duplicate and left untouched (dedupe). Events
 * still `new` may be refreshed (Plaid "modified") when `refresh` is set.
 */
export async function insertEvents(
  b: Base,
  user: Address,
  source: SourceName,
  sourceKey: string,
  events: { rowHash: string; event: SpendEvent }[],
  refresh = false,
): Promise<{ inserted: number; duplicates: number }> {
  let inserted = 0;
  for (let i = 0; i < events.length; i += 500) {
    const chunk = events.slice(i, i + 500).map(({ rowHash, event: e }) => ({
      chainId: b.chainId,
      userAddress: lc(user),
      rowHash,
      source,
      sourceKey,
      eventId: e.id,
      amountCents: e.amountCents,
      currency: e.currency,
      at: e.at,
      merchant: e.merchant ?? null,
      status: "new",
    }));
    const q = b.db.insert(roundupEvents).values(chunk);
    const rows = refresh
      ? await q
          .onConflictDoUpdate({
            target: [roundupEvents.chainId, roundupEvents.userAddress, roundupEvents.rowHash],
            set: { amountCents: sql`excluded.amount_cents`, at: sql`excluded.at`, merchant: sql`excluded.merchant`, updatedAt: sql`now()` },
            setWhere: sql`${roundupEvents.status} = 'new'`,
          })
          .returning({ h: roundupEvents.rowHash, fresh: sql<boolean>`(xmax = 0)` })
      : await q.onConflictDoNothing().returning({ h: roundupEvents.rowHash, fresh: sql<boolean>`true` });
    inserted += rows.filter((r) => r.fresh).length;
  }
  return { inserted, duplicates: events.length - inserted };
}

/** Parsed statement rows that carry a spend, ready for insertEvents. */
export const spendRows = (rows: ParsedRow[]) => rows.filter((r) => r.event).map((r) => ({ rowHash: r.rowHash, event: r.event! }));

/** Events of one user and source the keeper has not finished (new, or failed and retryable), oldest first. */
export async function openEvents(b: Base, user: Address, source: SourceName, since: Date, maxAttempts = 5): Promise<EventRow[]> {
  return b.db
    .select()
    .from(roundupEvents)
    .where(
      and(
        eq(roundupEvents.chainId, b.chainId),
        eq(roundupEvents.userAddress, lc(user)),
        eq(roundupEvents.source, source),
        inArray(roundupEvents.status, ["new", "failed"]),
        lt(roundupEvents.attempts, maxAttempts),
        gte(roundupEvents.at, since),
      ),
    )
    .orderBy(roundupEvents.at, roundupEvents.rowHash);
}

/** Marks open events dated before `since` as skipped (older than the lookback before linking). */
export async function skipOlderThan(b: Base, user: Address, source: SourceName, since: Date, reason: string): Promise<number> {
  const r = await b.db
    .update(roundupEvents)
    .set({ status: "skipped", reason, updatedAt: sql`now()` })
    .where(and(eq(roundupEvents.chainId, b.chainId), eq(roundupEvents.userAddress, lc(user)), eq(roundupEvents.source, source), eq(roundupEvents.status, "new"), lt(roundupEvents.at, since)))
    .returning({ h: roundupEvents.rowHash });
  return r.length;
}

/** Plaid removed these transactions: not yet accrued ones are skipped. */
export async function skipRemoved(b: Base, user: Address, rowHashes: string[]): Promise<void> {
  if (!rowHashes.length) return;
  await b.db
    .update(roundupEvents)
    .set({ status: "skipped", reason: "removed by the bank", updatedAt: sql`now()` })
    .where(and(eq(roundupEvents.chainId, b.chainId), eq(roundupEvents.userAddress, lc(user)), inArray(roundupEvents.rowHash, rowHashes), eq(roundupEvents.status, "new")));
}

export async function setEventResult(
  b: Base,
  row: Pick<EventRow, "userAddress" | "rowHash">,
  v: { status: "done" | "failed" | "skipped"; reason?: string | undefined; accrualKey?: string | undefined; added?: bigint | undefined; tx?: string | undefined },
): Promise<void> {
  await b.db
    .update(roundupEvents)
    .set({
      status: v.status,
      reason: v.reason ?? null,
      ...(v.accrualKey ? { accrualKey: v.accrualKey } : {}),
      ...(v.added !== undefined ? { added: v.added.toString() } : {}),
      ...(v.tx ? { accrueTx: v.tx.toLowerCase() } : {}),
      ...(v.status === "failed" ? { attempts: sql`${roundupEvents.attempts} + 1` } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(roundupEvents.chainId, b.chainId), eq(roundupEvents.userAddress, row.userAddress), eq(roundupEvents.rowHash, row.rowHash)));
}

export const toSpendEvent = (r: EventRow): SpendEvent => ({ id: r.eventId, amountCents: r.amountCents, currency: r.currency, at: r.at, merchant: r.merchant ?? undefined });
