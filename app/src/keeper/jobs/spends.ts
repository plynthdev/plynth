// Job: off-chain round-up sources (todo 23). For every user with an active statement or Plaid source:
// sync Plaid, then turn each open SpendEvent into vault.accrue(user, accrualKey(source, user, id), 0, cents x 1e4).
// The vault computes the round-up and enforces the weekly cap (across all sources, on-chain included) and
// replay protection; the keeper only reports spends. Events dated more than LOOKBACK before the source was
// linked are skipped, so an old statement cannot be replayed into this week's cap.
import { getAddress, type Address } from "viem";
import type { Ctx, JobResult } from "@/keeper/context";
import { accrueSpend } from "@/keeper/sources/accrue";
import { plaidRowHash, PlaidSource, StatementSource } from "@/keeper/sources/plaid";
import { activeSources, setEventResult, skipOlderThan } from "@/keeper/sources/store";
import { accrualKey, usdgUnits, type SourceName, type SpendSource } from "@/keeper/sources/types";

export const LOOKBACK_DAYS = 30;

export const rowHashOf = (source: SourceName, id: string) => (source === "plaid" ? plaidRowHash(id) : id);

/** Earliest date accepted for a source linked at `linkedAt`. */
export const sinceFor = (linkedAt: Date, lookbackDays = LOOKBACK_DAYS) => new Date(linkedAt.getTime() - lookbackDays * 86_400_000);

export async function runSpends(ctx: Ctx): Promise<JobResult> {
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
  for (const { user, kind, linkedAt } of groups.values()) {
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
      const key = accrualKey(kind, user, e.id);
      const o = await accrueSpend(ctx, user, key, 0, usdgUnits(e));
      if (o.status === "failed") {
        await setEventResult(ctx, row, { status: "failed", reason: o.reason, accrualKey: key });
        res.notes.push(`accrue ${kind} ${e.id.slice(0, 16)} reverts ${o.reason}`);
        continue;
      }
      await setEventResult(ctx, row, { status: "done", reason: o.reason, accrualKey: key, added: o.added, tx: o.tx });
      if (o.tx) res.actions++;
    }
  }
  return res;
}
