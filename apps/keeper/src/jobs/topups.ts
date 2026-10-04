// Job 2: weekly fixed top-ups. For each user with a fixed top-up setting, a live Permit2 allowance to the
// vault and the USDG to cover it, call vault.pullFixedTopUp(user). The amount and the 7-day spacing come
// from the vault, never from the keeper; the keeper only decides when to ask.
import { permit2Abi, erc20Abi, vaultAbi } from "../abi";
import { chainNow, simulate, type Ctx, type JobResult } from "../context";
import { setJob } from "../jobstore";
import { knownUsers } from "../state";

export const MAX_UINT160 = (1n << 160n) - 1n;
export const TOP_UP_SPACING = 7n * 24n * 3600n;

/** Permit2 AllowanceTransfer rules: not expired (expiration >= now), and amount covers `need` (max = unlimited). */
export function permit2Live(allow: { amount: bigint; expiration: bigint }, need: bigint, now: bigint): boolean {
  if (allow.expiration < now) return false;
  return allow.amount === MAX_UINT160 || allow.amount >= need;
}

/** Due when never pulled, or the vault's 7-day spacing has passed. */
export function topUpDue(lastTopUpAt: bigint, now: bigint): boolean {
  return lastTopUpAt === 0n || now >= lastTopUpAt + TOP_UP_SPACING;
}

export async function runTopups(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "topups", ok: true, actions: 0, notes: [] };
  const now = await chainNow(ctx);
  for (const user of await knownUsers(ctx.db, ctx.chainId, ctx.dep.vault)) {
    const s = (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "settingsOf", args: [user] })) as { fixedTopUp: bigint };
    const amount = BigInt(s.fixedTopUp);
    if (amount === 0n) continue;
    const acct = (await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "accountOf", args: [user] })) as { lastTopUpAt: bigint };
    if (!topUpDue(BigInt(acct.lastTopUpAt), now)) continue;
    const [allowed, expiration] = (await ctx.pub.readContract({
      address: ctx.dep.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [user, ctx.dep.usdg, ctx.dep.vault],
    })) as readonly [bigint, number, number];
    if (!permit2Live({ amount: allowed, expiration: BigInt(expiration) }, amount, now)) {
      res.notes.push(`${user}: no live Permit2 allowance`);
      continue;
    }
    const bal = (await ctx.pub.readContract({ address: ctx.dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [user] })) as bigint;
    if (bal < amount) {
      res.notes.push(`${user}: USDG balance below top-up`);
      continue;
    }
    const sim = await simulate(ctx, ctx.dep.vault, vaultAbi, "pullFixedTopUp", [user]);
    if (!sim.ok) {
      res.notes.push(`${user}: pullFixedTopUp reverts ${sim.errorName}`);
      continue;
    }
    const r = await ctx.sender.sendCall(ctx.dep.vault, vaultAbi, "pullFixedTopUp", [user], "pullFixedTopUp");
    await setJob(ctx, "topup", `${user.toLowerCase()}:${now}`, { status: "done", txHash: r.transactionHash, payload: { user, amount } });
    res.actions++;
  }
  return res;
}
