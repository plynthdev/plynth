// Venue sweep (review5 R5-PERP-1): when a treasury basis short is closed by someone else (a displacing open, a
// liquidation, settleHeld, settleRetired) its payout lands as idle USDG in the treasury's InHousePerpVenue, which no
// BasisSleeve pair operation moves. BasisSleeve.sweepVenueIdle(venue) (anyone; it can only pay the account) sends it
// back. The liquidate job calls `sweepVenueIdleOf` for every account it just closed, and `sweepDisplaced` for every
// Displaced event on the deployment's markets since its stored cursor. Best effort: a position owner that is not a
// treasury venue, or a venue whose sleeve has no sweep (a PerpSleeve hedge keeps its idle margin on purpose), is
// skipped; a failed read or send is a note, never a failed job (the cash stays sweepable by anyone).
import type { Address } from "viem";
import { perpMarketKeeperAbi, perpVenueKeeperAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import { getJob, setJob } from "@/keeper/jobstore";

/** First pass without a cursor looks back this many blocks for Displaced events. */
export const DISPLACED_LOOKBACK_BLOCKS = 50_000n;

/** Sweeps `venue`'s idle cash back to its treasury if it is a BasisSleeve venue holding any. */
export async function sweepVenueIdleOf(ctx: Pick<Ctx, "pub" | "account" | "sender">, venue: Address): Promise<"swept" | "none"> {
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address, abi: perpVenueKeeperAbi, functionName, args } as any) as Promise<T>;
  let sleeve: Address;
  let idle: bigint;
  try {
    sleeve = await read<Address>(venue, "sleeve");
    const cash = await read<Address>(venue, "cash");
    idle = BigInt(await read<bigint>(cash, "balanceOf", [venue]));
  } catch {
    return "none"; // not a treasury venue (a plain trader's address, or an unrelated contract)
  }
  if (idle === 0n) return "none";
  const sim = await simulate(ctx, sleeve, perpVenueKeeperAbi as any, "sweepVenueIdle", [venue]);
  if (!sim.ok) return "none"; // not a BasisSleeve (PerpSleeve keeps idle margin), or not its venue
  await ctx.sender.sendCall(sleeve, perpVenueKeeperAbi as any, "sweepVenueIdle", [venue], "perp.sweepVenueIdle");
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
