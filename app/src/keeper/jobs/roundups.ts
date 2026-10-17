// Job 1: round-ups. Every indexed USDG transfer out of a linked spending wallet becomes one
// vault.accrue(user, tx, logIndex, value). The vault's (tx, logIndex) replay guard makes this idempotent;
// a pre-simulated AlreadyAccrued just marks the row done.
import { keeperRoundups } from "@/db";
import { sql } from "drizzle-orm";
import { getAddress } from "viem";
import type { Ctx, JobResult } from "@/keeper/context";
import { AccrueGate, accrueSpend, DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS } from "@/keeper/sources/accrue";
import { OnchainSource } from "@/keeper/sources/onchain";
import type { SpendLog } from "@/keeper/state";

export { classifySpend, type SpendDecision } from "@/keeper/sources/onchain";
export { addedFromReceipt } from "@/keeper/sources/accrue";

type Row = typeof keeperRoundups.$inferInsert;

async function put(ctx: Ctx, s: SpendLog, patch: Partial<Row> & { status: string }, bumpAttempts = false) {
  const base: Row = {
    chainId: ctx.chainId,
    txHash: s.txHash.toLowerCase(),
    logIndex: s.logIndex,
    blockNumber: s.blockNumber.toString(),
    wallet: s.from.toLowerCase(),
    toAddress: s.to.toLowerCase(),
    spend: s.value.toString(),
    ...patch,
    attempts: bumpAttempts ? 1 : 0,
  };
  const { chainId: _c, txHash: _t, logIndex: _l, ...set } = base;
  await ctx.db
    .insert(keeperRoundups)
    .values(base)
    .onConflictDoUpdate({
      target: [keeperRoundups.chainId, keeperRoundups.txHash, keeperRoundups.logIndex],
      set: { ...set, attempts: bumpAttempts ? sql`${keeperRoundups.attempts} + 1` : sql`${keeperRoundups.attempts}`, updatedAt: sql`now()` },
    });
}

// On-chain spends have their own, lower minimum (KEEPER_MIN_ONCHAIN_ACCRUE_CENTS, default 5): each one is a
// transaction its sender paid for, but a 1e-6 USDG round-up still bought a full keeper transaction (review v3
// R3-SVC-2). Smaller round-ups are skipped with the reason, never sent. The pass, per-user and time/gas budgets apply.
export async function runRoundups(ctx: Ctx, gate = new AccrueGate(ctx, { minAccrueCents: ctx.accrueLimits?.minOnchainAccrueCents ?? DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS })): Promise<JobResult> {
  const res: JobResult = { job: "roundups", ok: true, actions: 0, notes: [] };
  for (const { spend: s, decision: d } of await new OnchainSource(ctx).scan()) {
    if (d.kind === "skip") {
      await put(ctx, s, { status: "skipped", reason: d.reason });
      continue;
    }
    const user = getAddress(d.user);
    const lu = user.toLowerCase();
    // Audit M-7: no transaction for a spend the vault would credit 0 for, and per-user / per-pass accrual limits.
    const g = await gate.check(user, s.value);
    if (!g.ok) {
      if (!g.skip) {
        res.notes.push(g.reason);
        break;
      }
      await put(ctx, s, { status: "skipped", userAddress: lu, reason: g.reason });
      continue;
    }
    // (txHash, logIndex) stay the accrual key for on-chain spends: the vault has keyed them so since todo 07.
    const o = await accrueSpend(ctx, user, s.txHash, s.logIndex, s.value, async () => {
      await put(ctx, s, { status: "pending", userAddress: lu });
    });
    if (o.status === "failed") {
      await put(ctx, s, { status: "failed", userAddress: lu, reason: o.reason }, true);
      res.notes.push(`accrue ${s.txHash}:${s.logIndex} reverts ${o.reason}`);
      continue;
    }
    await put(ctx, s, { status: "done", userAddress: lu, reason: o.reason ?? null, accrueTx: o.tx?.toLowerCase() ?? null, added: o.added?.toString() ?? null });
    if (o.tx) {
      gate.record(user, s.value, o.added, o.gasUsed);
      res.actions++;
    }
  }
  return res;
}
