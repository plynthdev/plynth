import { keeperJobs } from "@/db";
import { toJsonSafe } from "@/indexer";
import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "./context";

export type JobRow = typeof keeperJobs.$inferSelect;

export async function getJob(ctx: Pick<Ctx, "db" | "chainId">, kind: string, jobKey: string): Promise<JobRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(keeperJobs)
    .where(and(eq(keeperJobs.chainId, ctx.chainId), eq(keeperJobs.kind, kind), eq(keeperJobs.jobKey, jobKey)));
  return row;
}

/** Insert only if absent; returns the row that is stored afterwards (ours or the existing one). */
export async function insertJobIfAbsent(
  ctx: Pick<Ctx, "db" | "chainId">,
  kind: string,
  jobKey: string,
  v: { status: string; payload?: unknown; secretEnc?: string },
): Promise<JobRow> {
  await ctx.db
    .insert(keeperJobs)
    .values({ chainId: ctx.chainId, kind, jobKey, status: v.status, payload: v.payload === undefined ? null : toJsonSafe(v.payload), secretEnc: v.secretEnc ?? null })
    .onConflictDoNothing();
  return (await getJob(ctx, kind, jobKey))!;
}

/** Upsert status (+ optional tx, payload merge, error). The sealed secret is never overwritten here. */
export async function setJob(
  ctx: Pick<Ctx, "db" | "chainId">,
  kind: string,
  jobKey: string,
  v: { status: string; txHash?: string; payload?: Record<string, unknown>; error?: string },
): Promise<void> {
  const payload = toJsonSafe(v.payload ?? {}) as Record<string, unknown>;
  await ctx.db
    .insert(keeperJobs)
    .values({ chainId: ctx.chainId, kind, jobKey, status: v.status, payload, txHash: v.txHash ?? null, lastError: v.error ?? null, attempts: v.error ? 1 : 0 })
    .onConflictDoUpdate({
      target: [keeperJobs.chainId, keeperJobs.kind, keeperJobs.jobKey],
      set: {
        status: v.status,
        txHash: v.txHash ? v.txHash : sql`${keeperJobs.txHash}`,
        payload: sql`coalesce(${keeperJobs.payload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb`,
        lastError: v.error ?? null,
        attempts: v.error ? sql`${keeperJobs.attempts} + 1` : sql`${keeperJobs.attempts}`,
        updatedAt: sql`now()`,
      },
    });
}
