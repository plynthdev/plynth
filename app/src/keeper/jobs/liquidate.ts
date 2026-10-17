// Job liquidate (audit M-4, PERP-6): the protocol liquidator for the in-house perp markets. Every pass, for each
// market in the deployment, it lists the open positions on-chain (PerpMarket.openPositions, bounded at
// MAX_OPEN_POSITIONS per market) and liquidates every one below maintenance; liquidation always pays at least
// minLiquidationReward, so underwater positions (bad debt) are worth the gas too. On a market that has been on
// hold longer than HELD_GRACE (feed halted, token delisted) it settles each position at the last price
// (settleHeld) so open interest reaches zero and LP deposits reopen.
//
// Isolation: each account is its own try/catch, so one account that reverts or throws never stops the others,
// and each skip is a note. The market refuses a liquidation by the account itself or by one of its operators, so
// the keeper skips those (its key must be neither). A liquidatable account the keeper could not close fails the
// job (ok = false), which turns the keeper's /health red: an unliquidated position is a risk to the LPs.
import type { Address } from "viem";
import { perpMarketKeeperAbi, perpPoolKeeperAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";

export type LiquidationView = {
  account: Address;
  keeper: Address;
  /** pool.isOperator(account, keeper) */
  keeperIsOperator: boolean;
  liquidatable: boolean;
  /** The market has been on hold longer than HELD_GRACE. */
  settleable: boolean;
};

export type LiquidationAction = { kind: "liquidate" } | { kind: "settle" } | { kind: "skip"; reason: string } | { kind: "none" };

/** What the keeper does with one open position. Pure: mirrors PerpMarket.liquidate / settleHeld preconditions. */
export function liquidationAction(v: LiquidationView): LiquidationAction {
  const self = v.account.toLowerCase() === v.keeper.toLowerCase();
  if (v.liquidatable) {
    if (self) return { kind: "skip", reason: "the keeper's own position (the market refuses self-liquidation)" };
    if (v.keeperIsOperator) return { kind: "skip", reason: "the keeper is the account's operator (the market refuses it)" };
    return { kind: "liquidate" };
  }
  if (v.settleable) return { kind: "settle" };
  return { kind: "none" };
}

export async function runLiquidate(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "liquidate", ok: true, actions: 0, notes: [] };
  const markets = ctx.dep.perpMarkets ?? [];
  if (markets.length === 0) {
    res.notes.push("no perp markets in the deployment");
    return res;
  }
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = [], abi: any = perpMarketKeeperAbi) =>
    ctx.pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;
  for (const market of markets) {
    let accounts: readonly Address[];
    let pool: Address;
    let settleable: boolean;
    try {
      accounts = await read<readonly Address[]>(market, "openPositions");
      if (accounts.length === 0) continue;
      pool = await read<Address>(market, "pool");
      settleable = BigInt(await read<bigint>(market, "heldFor")) > BigInt(await read<bigint>(market, "HELD_GRACE"));
    } catch (err) {
      // An old market without openPositions, or the RPC: note it and go on with the other markets.
      res.ok = false;
      res.notes.push(`${market}: cannot list positions (${firstLine(err)})`);
      continue;
    }
    for (const account of accounts) {
      try {
        const liquidatable = await read<boolean>(market, "isLiquidatable", [account]);
        if (!liquidatable && !settleable) continue;
        const keeperIsOperator = await read<boolean>(pool, "isOperator", [account, ctx.account], perpPoolKeeperAbi);
        const action = liquidationAction({ account, keeper: ctx.account, keeperIsOperator, liquidatable, settleable });
        if (action.kind === "none") continue;
        if (action.kind === "skip") {
          res.ok = false; // liquidatable and still open: someone else must close it
          res.notes.push(`${market} ${account}: skipped, ${action.reason}`);
          continue;
        }
        const fn = action.kind === "liquidate" ? "liquidate" : "settleHeld";
        const sim = await simulate(ctx, market, perpMarketKeeperAbi as any, fn, [account]);
        if (!sim.ok) {
          // NotLiquidatable / NoPosition: the price or the position moved since the read (someone else won).
          if (sim.errorName !== "NotLiquidatable" && sim.errorName !== "NoPosition") res.ok = false;
          res.notes.push(`${market} ${account}: ${fn} reverts ${sim.errorName}`);
          continue;
        }
        await ctx.sender.sendCall(market, perpMarketKeeperAbi as any, fn, [account], `perp.${fn}`);
        res.actions++;
      } catch (err) {
        res.ok = false;
        res.notes.push(`${market} ${account}: failed (${firstLine(err)})`);
      }
    }
  }
  return res;
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0]!;
}
