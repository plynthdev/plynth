// Job: FeeRouter buyback. push() and observe() are keeper-only: the buy's reference price is the pool price
// the keeper recorded with observe() at least OBS_MIN_AGE (10 min) and at most OBS_MAX_AGE (2 h) before the
// push, so nobody can move the pool and push in one transaction. The keeper observes when it has no usable
// observation for the next push, and pushes once an hour with a minOut read from the pool just before it sends.
import { erc20Abi } from "@/abi/keeper";
import { feeRouterAbi } from "@/abi/treasury-token";
import { chainNow, simulate, type Ctx, type JobResult } from "@/keeper/context";

export const PUSH_INTERVAL = 3600n;
export const OBS_MIN_AGE = 600n;
export const OBS_MAX_AGE = 7200n;
/** Re-observe once the observation is older than this, so the next hourly push always has one in range. */
export const OBS_REFRESH_AGE = 3600n;

export type FeePushAction = "push" | "observe" | "wait";

/** What the keeper does this pass, from chain time, the router's lastPush and its observation time. */
export function feePushAction(now: bigint, lastPush: bigint, obsAt: bigint): FeePushAction {
  const age = obsAt === 0n ? undefined : now - obsAt;
  const due = lastPush === 0n || now >= lastPush + PUSH_INTERVAL;
  if (due && age !== undefined && age >= OBS_MIN_AGE && age <= OBS_MAX_AGE) return "push";
  if (age === undefined || age > OBS_REFRESH_AGE) return "observe";
  return "wait";
}

/** USDG the next push would spend on the buy (mirrors FeeRouter.push). */
export function buySpend(balance: bigint, buyCarry: bigint, authorReserved: bigint, perPushCap: bigint): bigint {
  const rest = balance - buyCarry - authorReserved;
  const spendable = buyCarry + (rest > 0n ? rest / 2n : 0n);
  return spendable < perPushCap ? spendable : perPushCap;
}

export async function runFeePush(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "fee-push", ok: true, actions: 0, notes: [] };
  const fr = ctx.dep.feeRouter;
  if (!fr) {
    res.notes.push("no FeeRouter in the deployment");
    return res;
  }
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address: fr, abi: feeRouterAbi, functionName, args } as any) as Promise<T>;
  const keeper = await read<string>("keeper");
  if (keeper.toLowerCase() !== ctx.account.toLowerCase()) {
    res.notes.push(`FeeRouter keeper is ${keeper}, not this keeper`);
    return res;
  }
  const now = await chainNow(ctx);
  const action = feePushAction(now, BigInt(await read<bigint>("lastPush")), BigInt(await read<bigint>("obsAt")));
  if (action === "wait") return res;
  if (action === "observe") {
    await ctx.sender.sendCall(fr, feeRouterAbi, "observe", [], "feeRouter.observe");
    res.actions++;
    return res;
  }
  const usdg = await read<`0x${string}`>("usdg");
  const bal = (await ctx.pub.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [fr] })) as bigint;
  const spend = buySpend(bal, await read<bigint>("buyCarry"), await read<bigint>("authorReserved"), await read<bigint>("perPushCap"));
  // The keeper's own bound: the pool as it reads it now. The router also checks the spot at inclusion and the
  // earlier observation, and takes the highest.
  const minOut = spend === 0n ? 0n : await read<bigint>("quoteMinOut", [spend]);
  const sim = await simulate(ctx, fr, feeRouterAbi, "push", [minOut]);
  if (!sim.ok) {
    res.notes.push(`push reverts ${sim.errorName}`);
    return res;
  }
  await ctx.sender.sendCall(fr, feeRouterAbi, "push", [minOut], "feeRouter.push");
  res.actions++;
  return res;
}
