// Job 3: sweep. crowd.join(user) for every user with pending > 0, batched through Multicall3 aggregate3
// (join is permissionless, so the multicall can be the caller). Each join is pre-simulated alone first, and
// the batch still uses allowFailure so one bad user cannot block the rest.
import { encodeFunctionData, type Address } from "viem";
import { crowdAbi, multicall3Abi, vaultAbi } from "../abi";
import { simulate, type Ctx, type JobResult } from "../context";
import { setJob } from "../jobstore";
import { knownUsers } from "../state";

export const SWEEP_BATCH = 50;

export function chunks<T>(xs: T[], n: number): T[][] {
  if (n < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function runSweep(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "sweep", ok: true, actions: 0, notes: [] };
  const ready: Address[] = [];
  for (const user of await knownUsers(ctx.db, ctx.chainId, ctx.dep.vault)) {
    const [, pending] = (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "balancesOf", args: [user] })) as readonly [bigint, bigint];
    if (pending === 0n) continue;
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "join", [user]);
    if (!sim.ok) {
      res.notes.push(`${user}: join reverts ${sim.errorName}`);
      continue;
    }
    ready.push(user);
  }
  for (const batch of chunks(ready, SWEEP_BATCH)) {
    const calls = batch.map((u) => ({ target: ctx.dep.crowd, allowFailure: true, callData: encodeFunctionData({ abi: crowdAbi, functionName: "join", args: [u] }) }));
    const r = await ctx.sender.sendCall(ctx.dep.multicall3, multicall3Abi, "aggregate3", [calls], "sweep");
    await setJob(ctx, "sweep", r.transactionHash.toLowerCase(), { status: "done", txHash: r.transactionHash, payload: { users: batch } });
    res.actions++;
  }
  return res;
}
