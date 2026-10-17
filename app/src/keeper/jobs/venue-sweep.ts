// Venue sweep (review5 R5-PERP-1): when a treasury basis short is closed by someone else (a displacing open, a
// liquidation, settleHeld, settleRetired) its payout lands as idle USDG in the treasury's InHousePerpVenue, which no
// BasisSleeve pair operation moves. BasisSleeve.sweepVenueIdle(venue) (anyone; it can only pay the account) sends it
// back. The liquidate job calls `sweepVenueIdleOf` for every account it just closed, and `sweepDisplaced` for every
// Displaced event on the deployment's markets since its stored cursor. Only sleeves of factory treasuries are swept,
// checked through the factory, the account and the sleeve, with a gas cap (review6 R6-SVC-1). Best effort: a position owner that is not a
// treasury venue, or a venue whose sleeve has no sweep (a PerpSleeve hedge keeps its idle margin on purpose), is
// skipped; a failed read or send is a note, never a failed job (the cash stays sweepable by anyone).
import type { Address } from "viem";
import { perpMarketKeeperAbi, perpVenueKeeperAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import { getJob, setJob } from "@/keeper/jobstore";

/** First pass without a cursor looks back this many blocks for Displaced events. */
export const DISPLACED_LOOKBACK_BLOCKS = 50_000n;

/** Gas ceiling of one venue sweep (review6 R6-SVC-1). A real BasisSleeve sweep is one USDG transfer out of the venue
 * and one in; anything that estimates above this is not one, and nothing is signed. */
export const VENUE_SWEEP_MAX_GAS = 400_000n;

/**
 * Sweeps `venue`'s idle cash back to its treasury if it is a BasisSleeve venue holding any. `venue` comes from a
 * Displaced event or a closed position, i.e. from anyone (review6 R6-SVC-1), so nothing it says is trusted until the
 * chain's own registries confirm it: its sleeve's `account()` is a treasury of a deployment TreasuryFactory
 * (`isTreasury`), that account lists the sleeve (`isSleeve`), the sleeve lists the venue (`isVenue`), and the venue's
 * cash is the deployment's USDG. Only then is the sweep simulated and sent, with gas capped at VENUE_SWEEP_MAX_GAS.
 */
export async function sweepVenueIdleOf(ctx: Pick<Ctx, "pub" | "account" | "sender" | "dep">, venue: Address): Promise<"swept" | "none"> {
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address, abi: perpVenueKeeperAbi, functionName, args } as any) as Promise<T>;
  const factories = ctx.dep.treasuryFactories ?? [];
  if (factories.length === 0 || !ctx.dep.usdg) return "none"; // no treasury factory in this deployment: nothing to trust
  let sleeve: Address;
  let idle: bigint;
  try {
    sleeve = await read<Address>(venue, "sleeve");
    const cash = await read<Address>(venue, "cash");
    if (cash.toLowerCase() !== ctx.dep.usdg.toLowerCase()) return "none";
    const account = await read<Address>(sleeve, "account");
    let registered = false;
    for (const f of factories) {
      if (await read<boolean>(f, "isTreasury", [account])) {
        registered = true;
        break;
      }
    }
    if (!registered) return "none";
    if (!(await read<boolean>(account, "isSleeve", [sleeve]))) return "none";
    if (!(await read<boolean>(sleeve, "isVenue", [venue]))) return "none";
    idle = BigInt(await read<bigint>(ctx.dep.usdg, "balanceOf", [venue]));
  } catch {
    return "none"; // not a treasury venue (a plain trader's address, or an unrelated contract)
  }
  if (idle === 0n) return "none";
  const sim = await simulate(ctx, sleeve, perpVenueKeeperAbi as any, "sweepVenueIdle", [venue]);
  if (!sim.ok) return "none"; // not a BasisSleeve (PerpSleeve keeps idle margin), or not its venue
  await ctx.sender.sendCall(sleeve, perpVenueKeeperAbi as any, "sweepVenueIdle", [venue], "perp.sweepVenueIdle", { maxGas: VENUE_SWEEP_MAX_GAS });
  return "swept";
}

/** Sweeps the venue of every Displaced event since the cursor (one cursor per market, in keeper_jobs). */
export async function sweepDisplaced(ctx: Ctx, res: JobResult): Promise<void> {
  const head = await ctx.pub.getBlockNumber();
  for (const market of ctx.dep.perpMarkets ?? []) {
    try {
      const key = market.toLowerCase();
      const row = ctx.db ? await getJob(ctx, "venue-sweep", key) : undefined; // no store (tests): lookback only
      const from = row?.payload && (row.payload as any).nextBlock !== undefined
        ? BigInt((row.payload as any).nextBlock)
        : head > DISPLACED_LOOKBACK_BLOCKS ? head - DISPLACED_LOOKBACK_BLOCKS : 0n;
      if (from > head) continue;
      const ev = perpMarketKeeperAbi.find((x) => x.type === "event" && x.name === "Displaced");
      const logs = (await ctx.pub.getLogs({ address: market, event: ev, fromBlock: from, toBlock: head } as any)) as unknown as { args: { account: Address } }[];
      const venues = [...new Set(logs.map((l) => l.args.account))];
      for (const v of venues) {
        if ((await sweepVenueIdleOf(ctx, v)) === "swept") {
          res.actions++;
          res.notes.push(`${market} displaced ${v}: idle cash swept to its treasury`);
        }
      }
      if (ctx.db) await setJob(ctx, "venue-sweep", key, { status: "done", payload: { nextBlock: (head + 1n).toString() } });
    } catch (err) {
      res.notes.push(`${market}: displaced-venue sweep skipped (${String((err as Error)?.message ?? err).split("\n")[0]})`);
    }
  }
}
