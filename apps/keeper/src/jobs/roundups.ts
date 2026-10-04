// Job 1: round-ups. Every indexed USDG transfer out of a linked spending wallet becomes one
// vault.accrue(user, tx, logIndex, value). The vault's (tx, logIndex) replay guard makes this idempotent;
// a pre-simulated AlreadyAccrued just marks the row done.
import { keeperRoundups } from "@plynth/db";
import { linkedUserAt, linkEvents, linkIntervals, type LinkInterval } from "@plynth/indexer";
import { sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type TransactionReceipt } from "viem";
import { vaultAbi } from "../abi";
import { simulate, type Ctx, type JobResult } from "../context";
import { openSpends, type SpendLog } from "../state";

export type SpendDecision = { kind: "accrue"; user: string } | { kind: "skip"; reason: string };

/** Pure: is this transfer a round-up source, and for whom? */
export function classifySpend(s: SpendLog, intervals: Map<string, LinkInterval[]>, plynth: Set<string>): SpendDecision {
  const user = linkedUserAt(intervals, s.from, s.blockNumber);
  if (!user) return { kind: "skip", reason: "wallet not linked at this block" };
  if (plynth.has(s.to.toLowerCase())) return { kind: "skip", reason: "transfer into a Plynth contract" };
  if (s.value === 0n) return { kind: "skip", reason: "zero-value transfer" };
  return { kind: "accrue", user };
}

/** The `added` amount from the vault's Accrued event in a receipt. */
export function addedFromReceipt(r: TransactionReceipt, vault: string): bigint | undefined {
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Accrued") return (ev.args as { added: bigint }).added;
    } catch {
      // another vault event
    }
  }
  return undefined;
}

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

export async function runRoundups(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "roundups", ok: true, actions: 0, notes: [] };
  const intervals = linkIntervals(await linkEvents(ctx.db, ctx.chainId, ctx.dep.vault));
  const spends = await openSpends(ctx.db, ctx.chainId, ctx.dep.usdg, [...intervals.keys()]);
  for (const s of spends) {
    const d = classifySpend(s, intervals, ctx.dep.plynth);
    if (d.kind === "skip") {
      await put(ctx, s, { status: "skipped", reason: d.reason });
      continue;
    }
    const user = getAddress(d.user);
    const args = [user, s.txHash, s.logIndex, s.value] as const;
    const sim = await simulate(ctx, ctx.dep.vault, vaultAbi, "accrue", args);
    if (!sim.ok) {
      if (sim.errorName === "AlreadyAccrued") {
        await put(ctx, s, { status: "done", userAddress: user.toLowerCase(), reason: "already accrued" });
      } else {
        await put(ctx, s, { status: "failed", userAddress: user.toLowerCase(), reason: sim.errorName }, true);
        res.notes.push(`accrue ${s.txHash}:${s.logIndex} reverts ${sim.errorName}`);
      }
      continue;
    }
    await put(ctx, s, { status: "pending", userAddress: user.toLowerCase() });
    const r = await ctx.sender.sendCall(ctx.dep.vault, vaultAbi, "accrue", args, "accrue");
    const added = addedFromReceipt(r, ctx.dep.vault);
    await put(ctx, s, { status: "done", userAddress: user.toLowerCase(), accrueTx: r.transactionHash.toLowerCase(), added: added?.toString() ?? null });
    res.actions++;
  }
  return res;
}
