// Job 3: sweep. Every user with pending > 0 is joined through crowd.joinBatch(users), sent by the keeper: join is
// user-or-keeper only on-chain (audit L-3), so a Multicall3 can no longer be the caller. Each join is pre-simulated
// alone first (as the keeper), and joinBatch itself skips anyone who cannot join, so one bad user cannot block the rest.
import { parseEventLogs, type Address } from "viem";
import { withGasHeadroom } from "@/lib/gas";
import { crowdAbi, vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import { setJob } from "@/keeper/jobstore";
import { knownUsers } from "@/keeper/state";

export const SWEEP_BATCH = 50;
/** joinBatch's own cost per user (its eligibility / balance / mix pre-checks) and once per batch, rounded up. */
export const MULTICALL_PER_CALL_GAS = 15_000n;
export const MULTICALL_BASE_GAS = 40_000n;

/**
 * Gas floor for one joinBatch: each join's own estimate (made as the keeper, the batch's caller) plus +25% / +50k
 * headroom (a join can open a new book, cold slots), plus the batch's per-user checks and base cost. Without it the
 * batch's estimate can land at the gas where the last joins run out (seen on the fork with the old multicall batch:
 * limit 70k, join 150k).
 */
export function sweepGasFloor(joinEstimates: readonly bigint[]): bigint {
  return joinEstimates.reduce((sum, g) => sum + withGasHeadroom(g) + MULTICALL_PER_CALL_GAS, MULTICALL_BASE_GAS);
}

export function chunks<T>(xs: T[], n: number): T[][] {
  if (n < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function runSweep(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "sweep", ok: true, actions: 0, notes: [] };
  const ready: Address[] = [];
  const gasOf = new Map<Address, bigint>();
  for (const user of await knownUsers(ctx.db, ctx.chainId, ctx.dep.vault)) {
    // Per user: a read or estimate that throws for one user is a note, never the end of the sweep for everyone.
    try {
      const [, pending] = (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "balancesOf", args: [user] })) as readonly [bigint, bigint];
      if (pending === 0n) continue;
      const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "join", [user]);
      if (!sim.ok) {
        res.notes.push(`${user}: join reverts ${sim.errorName}`);
        continue;
      }
      gasOf.set(user, await ctx.pub.estimateContractGas({ account: ctx.account, address: ctx.dep.crowd, abi: crowdAbi, functionName: "join", args: [user] } as any));
      ready.push(user);
    } catch (err) {
      res.notes.push(`${user}: skipped this pass (${String((err as Error)?.message ?? err).split("\n")[0]})`);
    }
  }
  for (const batch of chunks(ready, SWEEP_BATCH)) {
    const minGas = sweepGasFloor(batch.map((u) => gasOf.get(u)!));
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "joinBatch", [batch], "sweep", { minGas });
    // joinBatch skips users who cannot join: count the Joined events (one or more per joined user) to report the truth.
    const joined = new Set(
      parseEventLogs({ abi: crowdAbi, logs: r.logs, eventName: "Joined" }).map((l) => (l.args as { user: Address }).user.toLowerCase()),
    );
    const missed = batch.filter((u) => !joined.has(u.toLowerCase()));
    if (missed.length) res.notes.push(`sweep ${r.transactionHash}: join had no effect for ${missed.join(", ")}`);
    await setJob(ctx, "sweep", r.transactionHash.toLowerCase(), { status: "done", txHash: r.transactionHash, payload: { users: batch, missed } });
    res.actions++;
  }
  return res;
}
