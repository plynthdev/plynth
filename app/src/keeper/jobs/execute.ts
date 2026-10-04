// Job 5: crowd execution. When the window's beacon time has passed, the open book has at least MIN_CROWD
// accounts, it has not executed this window and the oracle is not on hold, call crowd.execute(asset).
// CrowdBuy re-checks all of it; the keeper's checks only avoid sending transactions that would revert.
import type { Address } from "viem";
import { beaconAbi, crowdAbi, valuerAbi } from "@/abi/keeper";
import { chainNow, simulate, type Ctx, type JobResult } from "@/keeper/context";
import { setJob } from "@/keeper/jobstore";
import { beaconKey, readTiming, windowAt } from "./beacon";

export type ExecState = { accounts: number; minCrowd: number; executedThisWindow: boolean; executeAfter: bigint; now: bigint; hold: boolean };

/** Pure gate mirroring CrowdBuy.execute's preconditions. Returns the reason to wait, or null when ready. */
export function executeBlocker(s: ExecState): string | null {
  if (s.accounts < s.minCrowd) return `crowd ${s.accounts} < ${s.minCrowd}`;
  if (s.executedThisWindow) return "already executed this window";
  if (s.now < s.executeAfter) return `too early (executeAfter ${s.executeAfter})`;
  if (s.hold) return "oracle on hold";
  return null;
}

export async function runExecute(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "execute", ok: true, actions: 0, notes: [] };
  const t = await readTiming(ctx);
  const now = await chainNow(ctx);
  if (now < t.genesis) return res;
  const { start } = windowAt(now, t.genesis, t.window);
  const minCrowd = Number(await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "MIN_CROWD" }));
  const valuer = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "valuer" })) as Address;
  for (const asset of ctx.dep.stocks) {
    const [bookId, book] = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "openBook", args: [asset] })) as readonly [bigint, { accounts: number; usdgTotal: bigint }];
    if (Number(book.accounts) === 0) continue;
    const last = BigInt((await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "lastExecutedWindow", args: [asset] })) as bigint);
    const executeAfter = BigInt((await ctx.pub.readContract({ address: ctx.dep.beacon, abi: beaconAbi, functionName: "executeAfter", args: [beaconKey(asset, start)] })) as bigint);
    const q = (await ctx.pub.readContract({ address: valuer, abi: valuerAbi, functionName: "quote", args: [asset] })) as { hold: boolean };
    const why = executeBlocker({ accounts: Number(book.accounts), minCrowd, executedThisWindow: last === start + 1n, executeAfter, now, hold: q.hold });
    if (why) {
      res.notes.push(`${asset} book ${bookId}: ${why}`);
      continue;
    }
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "execute", [asset]);
    if (!sim.ok) {
      res.notes.push(`${asset} book ${bookId}: execute reverts ${sim.errorName}`);
      continue;
    }
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "execute", [asset], "execute");
    await setJob(ctx, "execute", `${asset.toLowerCase()}:${bookId}`, {
      status: "done",
      txHash: r.transactionHash,
      payload: { asset, bookId, windowStart: start, executeAfter, usdgTotal: book.usdgTotal, accounts: Number(book.accounts) },
    });
    res.actions++;
  }
  return res;
}
