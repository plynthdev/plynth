// Job: off-chain round-up sources (todo 23). For every user with an active statement or Plaid source:
// sync Plaid, then turn each open SpendEvent into vault.accrue(user, accrualKey(source, user, id), 0, cents x 1e4).
// The vault computes the round-up and enforces the weekly cap (across all sources, on-chain included) and
// replay protection; the keeper only reports spends. Events dated more than LOOKBACK before the source was
// linked are skipped, so an old statement cannot be replayed into this week's cap.
// Audit M-7: nothing is sent for a user the vault cannot credit (no settings, nothing available, no room under the
// weekly cap, a whole-amount spend): those rows are skipped with the reason. Accruals are also capped per user per
// vault week and per pass (AccrueGate), and this job runs after the core jobs (keeper.ts), so imports can never
// starve sweep, beacon, execute or delivery of the keeper's gas or time.
// Review v2 (V2-M5): each accrual must move at least $0.25 (KEEPER_MIN_ACCRUE_CENTS), at most KEEPER_MAX_ACCRUALS_PER_USER_PASS
// per user per pass, and the job stops at its wall-clock and gas budget (KEEPER_ACCRUE_PASS_MS / _GAS).
import { getAddress, type Address } from "viem";
import type { Ctx, JobResult } from "@/keeper/context";
import { AccrueGate, accrueSpend } from "@/keeper/sources/accrue";
import { longestWaitingFirst } from "@/keeper/jobs/roundups";
import { sql } from "drizzle-orm";
import { plaidRowHash, PlaidSource, StatementSource } from "@/keeper/sources/plaid";
import { activeSources, setEventResult, skipOlderThan } from "@/keeper/sources/store";
import { accrualKey, usdgUnits, type SourceName, type SpendSource } from "@/keeper/sources/types";

export const LOOKBACK_DAYS = 30;

export const rowHashOf = (source: SourceName, id: string) => (source === "plaid" ? plaidRowHash(id) : id);

/** Earliest date accepted for a source linked at `linkedAt`. */
export const sinceFor = (linkedAt: Date, lookbackDays = LOOKBACK_DAYS) => new Date(linkedAt.getTime() - lookbackDays * 86_400_000);

export async function runSpends(ctx: Ctx, gate = new AccrueGate(ctx)): Promise<JobResult> {
  const res: JobResult = { job: "spends", ok: true, actions: 0, notes: [] };
  const all = await activeSources(ctx);
  const sources: Record<"statement" | "plaid", SpendSource | undefined> = {
    statement: new StatementSource(ctx),
    plaid: ctx.plaid ? new PlaidSource({ db: ctx.db, chainId: ctx.chainId, sealer: ctx.sealer, plaid: ctx.plaid }) : undefined,
  };
  if (!ctx.plaid && all.some((s) => s.kind === "plaid")) res.notes.push("plaid sources linked but PLAID_CLIENT_ID/PLAID_SECRET not set");

  // One (user, kind) at a time, from the earliest link of that kind.
  const groups = new Map<string, { user: Address; kind: "statement" | "plaid"; linkedAt: Date }>();
  for (const s of all) {
    if (s.kind !== "statement" && s.kind !== "plaid") continue;
    const k = `${s.userAddress}|${s.kind}`;
    const g = groups.get(k);
    if (!g || s.createdAt < g.linkedAt) groups.set(k, { user: getAddress(s.userAddress), kind: s.kind, linkedAt: s.createdAt });
  }
  // Longest waiting first (fix-keeper-fair, review v5 R5-SVC-1): waiting since max(the oldest open row's import time,
  // the last accrue), so fresh wallets queue behind older imports and nobody is always last. A user at their per-pass
  // limit stops only their own rows (the break below), never the others'.
  const lowers = [...new Set([...groups.values()].map((g) => g.user.toLowerCase()))];
  const pending =
    lowers.length <= 1
      ? []
      : ((await ctx.db.execute(sql`
          select user_address as u, min(created_at) as t from roundup_events
          where chain_id = ${ctx.chainId} and status = 'new' and user_address in ${sql`(${sql.join(lowers.map((u) => sql`${u}`), sql`, `)})`}
          group by user_address`)) as unknown as { u: string; t: Date | string }[]);
  const oldest = new Map(pending.map((r) => [r.u, new Date(r.t).getTime()]));
  const rank = new Map((await longestWaitingFirst(ctx, sql`roundup_events`, lowers, oldest)).map((u, i) => [u, i]));
  const ordered = [...groups.values()].sort((a, b) => rank.get(a.user.toLowerCase())! - rank.get(b.user.toLowerCase())!);
  for (const { user, kind, linkedAt } of ordered) {
    if (gate.passFull()) break;
    const src = sources[kind];
    if (!src) continue;
    const since = sinceFor(linkedAt);
    await skipOlderThan(ctx, user, kind, since, `older than ${LOOKBACK_DAYS} days before the source was linked`);
    const events = await src.fetch(user, since);
    if (src instanceof PlaidSource) for (const [item, err] of src.errors) res.notes.push(`plaid ${user} ${item}: ${err}`);
    for (const e of events) {
      const row = { userAddress: user.toLowerCase(), rowHash: rowHashOf(kind, e.id) };
      if (e.currency !== "USD") {
        await setEventResult(ctx, row, { status: "skipped", reason: `currency ${e.currency} is not USD` });
        continue;
      }
      const units = usdgUnits(e);
      const g = await gate.check(user, units);
      if (!g.ok) {
        if (!g.skip) break; // pass (or this user's per-pass) budget used: this row and the rest stay open for the next pass
        await setEventResult(ctx, row, { status: "skipped", reason: g.reason });
        continue;
      }
      const key = accrualKey(kind, user, e.id);
      const o = await accrueSpend(ctx, user, key, 0, units);
      if (o.status === "failed") {
        await setEventResult(ctx, row, { status: "failed", reason: o.reason, accrualKey: key });
        res.notes.push(`accrue ${kind} ${e.id.slice(0, 16)} reverts ${o.reason}`);
        continue;
      }
      await setEventResult(ctx, row, { status: "done", reason: o.reason, accrualKey: key, added: o.added, tx: o.tx });
      if (o.tx) {
        gate.record(user, units, o.added, o.gasUsed);
        res.actions++;
      }
    }
  }
  const spent = gate.passSpent();
  if (spent) res.notes.push(`${spent}: the rest waits for the next pass`);
  return res;
}
