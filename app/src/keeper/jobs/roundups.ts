// Job 1: round-ups. Every indexed USDG transfer out of a linked spending wallet becomes one
// vault.accrue(user, tx, logIndex, value), or, when its round-up is under the on-chain minimum, a "carried" row that
// later goes out in one vault.accrueBatch with the user's other carried spends. The vault's (tx, logIndex) replay guard
// makes both idempotent; a pre-simulated AlreadyAccrued just marks the row done.
import { keeperRoundups } from "@/db";
import { sql } from "drizzle-orm";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { vaultAbi } from "@/abi/keeper";
import type { Ctx, JobResult } from "@/keeper/context";
import { AccrueGate, accrueBatchSpends, accrueSpend, batchKey, DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS, MAX_ACCRUE_BATCH } from "@/keeper/sources/accrue";
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
// R3-SVC-2). A smaller round-up is not sent on its own: its row is "carried" (once per spend key, so a restart or a
// re-index never counts it twice), and once a user's carried round-ups, computed with the settings in force now, add
// up to the minimum, ONE accrueBatch sends up to MAX_ACCRUE_BATCH of them (see flushCarried). The pass, per-user and
// time/gas budgets apply; a batch counts as one keeper transaction.
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
      if (g.belowMin) {
        await put(ctx, s, { status: "carried", userAddress: lu, reason: `${g.reason}; carried until this user's carried round-ups reach it` });
        continue;
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
  await flushCarried(ctx, gate, res);
  return res;
}

/** Reason of carried rows already weighed and still under the minimum (see flushCarried). */
export const WAITING = "carried: this user's carried round-ups are still under the keeper minimum";

type Carried = { tx_hash: string; log_index: number; spend: string };

async function markCarried(ctx: Ctx, user: string, rows: readonly Carried[], patch: Partial<Row> & { status: string }, bumpAttempts = false) {
  for (const r of rows) {
    await ctx.db
      .update(keeperRoundups)
      .set({ ...patch, ...(bumpAttempts ? { attempts: sql`${keeperRoundups.attempts} + 1` } : {}), updatedAt: sql`now()` })
      .where(sql`${keeperRoundups.chainId} = ${ctx.chainId} and ${keeperRoundups.txHash} = ${r.tx_hash} and ${keeperRoundups.logIndex} = ${r.log_index} and ${keeperRoundups.userAddress} = ${user} and ${keeperRoundups.status} = 'carried'`);
  }
}

/** The batch keys the vault has already burned (SavingsVault.sourceUsed). */
async function usedKeys(ctx: Ctx, rows: readonly Carried[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of rows) {
    const key = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [r.tx_hash as `0x${string}`, Number(r.log_index)]));
    if (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "sourceUsed", args: [key] })) out.add(batchKey(r.tx_hash, Number(r.log_index)));
  }
  return out;
}

/**
 * Sends each user's carried round-ups once they are worth a keeper transaction: per user, the (up to)
 * MAX_ACCRUE_BATCH carried spends with the largest round-ups under the settings in force now, in one accrueBatch,
 * when their round-ups add up to the minimum; otherwise they keep waiting. Rows marked done carry the batch's tx hash
 * and what the vault moved for each spend (its Accrued event). A spend the vault would now credit 0 for (no settings,
 * no balance, cap reached, weekly limit) is skipped with the gate's reason, as a single spend is; an exact amount under
 * the current settings is skipped as "no round-up". A key the vault already has (an earlier pass that stopped before
 * recording, or a single accrue) reverts the batch; every key of the batch the vault has (sourceUsed) is then marked done
 * "already accrued" and the rest is retried; any other revert leaves the rows carried (attempts + 1) and moves on to the
 * next user.
 *
 * Rows weighed and still under the minimum are marked WAITING and weighed again only when the user's next sub-minimum
 * spend is carried (a settings change alone does not wake them; they are dust, and they wait, never get lost).
 */
async function flushCarried(ctx: Ctx, gate: AccrueGate, res: JobResult) {
  // Only users with something new to weigh (a newly carried spend, a pass that stopped before them, a failed batch):
  // a user found below the minimum is marked WAITING and costs nothing per pass until their next carried spend, so
  // wallets full of dust cannot spend every pass's budget on re-evaluating themselves. Oldest first.
  const users = (await ctx.db.execute(sql`
    select user_address as u from keeper_roundups
    where chain_id = ${ctx.chainId} and status = 'carried' and user_address is not null and reason is distinct from ${WAITING}
    group by user_address order by min(updated_at), user_address limit 1000`)) as unknown as { u: string }[];
  for (const { u } of users) {
    const user = getAddress(u);
    for (;;) {
      const spent = gate.passSpent();
      if (spent) {
        res.notes.push(spent);
        return;
      }
      const { roundTo, unit } = await gate.roundingOf(user);
      const step = BigInt(roundTo) * unit;
      if (step > 0n) {
        // Whole amounts under the settings in force now: the vault would add 0, exactly like a single spend.
        await ctx.db.execute(sql`
          update keeper_roundups set status = 'skipped', reason = 'no round-up (whole amount): the vault would add 0', updated_at = now()
          where chain_id = ${ctx.chainId} and user_address = ${u} and status = 'carried' and spend % ${step.toString()} = 0`);
      }
      const rows = (await ctx.db.execute(sql`
        select tx_hash, log_index, spend from keeper_roundups
        where chain_id = ${ctx.chainId} and user_address = ${u} and status = 'carried'
        order by ${step > 0n ? sql`(${step.toString()} - spend % ${step.toString()})` : sql`0`} desc, block_number, log_index
        limit ${MAX_ACCRUE_BATCH}`)) as unknown as Carried[];
      if (!rows.length) break;
      const g = await gate.checkBatch(user, rows.map((r) => BigInt(r.spend)));
      if (!g.ok) {
        if (g.skip && g.belowMin) {
          // Not worth a transaction yet: keep carrying, and do not look again until a new carried spend arrives.
          await ctx.db.execute(sql`
            update keeper_roundups set reason = ${WAITING}, updated_at = now()
            where chain_id = ${ctx.chainId} and user_address = ${u} and status = 'carried'`);
          break;
        }
        if (!g.skip) {
          res.notes.push(g.reason);
          if (gate.passFull()) return;
          break; // this user's pass limit: next user
        }
        await ctx.db.execute(sql`
          update keeper_roundups set status = 'skipped', reason = ${g.reason}, updated_at = now()
          where chain_id = ${ctx.chainId} and user_address = ${u} and status = 'carried'`);
        break;
      }
      const o = await accrueBatchSpends(ctx, user, rows.map((r) => ({ sourceTx: r.tx_hash as `0x${string}`, logIndex: Number(r.log_index), units: BigInt(r.spend) })));
      if (o.status === "replay") {
        // Stale rows (an earlier pass that stopped before recording, or a single accrue): ask the vault which of this
        // batch's keys it already has, mark those done, and send the rest (if still worth a transaction).
        const used = await usedKeys(ctx, rows);
        const hit = rows.filter((r) => used.has(batchKey(r.tx_hash, Number(r.log_index))) || (r.tx_hash === o.sourceTx.toLowerCase() && Number(r.log_index) === o.logIndex));
        if (!hit.length) {
          res.notes.push(`accrueBatch ${u} reverts AlreadyAccrued for a key it was not sent`);
          break;
        }
        await markCarried(ctx, u, hit, { status: "done", reason: "already accrued" });
        res.notes.push(`accrueBatch ${u}: ${hit.length} spend(s) already accrued, sending the rest`);
        continue;
      }
      if (o.status === "failed") {
        await markCarried(ctx, u, rows, { status: "carried", reason: `accrueBatch reverts ${o.reason}` }, true);
        res.notes.push(`accrueBatch ${u} reverts ${o.reason}`);
        break;
      }
      for (const r of rows) {
        const added = o.added.get(batchKey(r.tx_hash, Number(r.log_index)));
        await markCarried(ctx, u, [r], { status: "done", reason: "carried round-up, sent in a batch", accrueTx: o.tx.toLowerCase(), added: added?.toString() ?? null });
      }
      gate.recordBatch(user, o.total, o.gasUsed);
      res.actions++;
    }
  }
}
