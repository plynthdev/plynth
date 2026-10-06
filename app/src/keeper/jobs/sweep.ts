// Job 3: sweep. crowd.join(user) for every user with pending > 0, batched through Multicall3 aggregate3
// (join is permissionless, so the multicall can be the caller). Each join is pre-simulated alone first, and
// the batch still uses allowFailure so one bad user cannot block the rest.
import { encodeFunctionData, parseEventLogs, type Address } from "viem";
import { withGasHeadroom } from "@/lib/gas";
import { crowdAbi, multicall3Abi, vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import { setJob } from "@/keeper/jobstore";
import { knownUsers } from "@/keeper/state";

export const SWEEP_BATCH = 50;
/** aggregate3's own cost per call (calldata decode, result encode) and once per batch, generously rounded up. */
export const MULTICALL_PER_CALL_GAS = 15_000n;
export const MULTICALL_BASE_GAS = 40_000n;

/**
 * Gas floor for one aggregate3 batch of joins: each join's own estimate (made as the multicall, its real caller)
 * plus +25% / +50k headroom (a join can open a new book, cold slots), plus the multicall's overhead.
 * Without it the batch's estimate is the gas at which every join runs out of gas: allowFailure turns that into a
 * successful no-op transaction, so pending round-ups were never swept (seen on the fork: limit 70k, join 150k).
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
    const [, pending] = (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "balancesOf", args: [user] })) as readonly [bigint, bigint];
    if (pending === 0n) continue;
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "join", [user]);
    if (!sim.ok) {
      res.notes.push(`${user}: join reverts ${sim.errorName}`);
      continue;
    }
    gasOf.set(user, await ctx.pub.estimateContractGas({ account: ctx.dep.multicall3, address: ctx.dep.crowd, abi: crowdAbi, functionName: "join", args: [user] } as any));
    ready.push(user);
  }
  for (const batch of chunks(ready, SWEEP_BATCH)) {
    const calls = batch.map((u) => ({ target: ctx.dep.crowd, allowFailure: true, callData: encodeFunctionData({ abi: crowdAbi, functionName: "join", args: [u] }) }));
    const minGas = sweepGasFloor(batch.map((u) => gasOf.get(u)!));
    const r = await ctx.sender.sendCall(ctx.dep.multicall3, multicall3Abi, "aggregate3", [calls], "sweep", { minGas });
    // allowFailure hides failed joins: count the Joined events (one or more per joined user) to report the truth.
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
