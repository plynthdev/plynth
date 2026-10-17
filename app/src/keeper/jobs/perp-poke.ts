// perp-poke (run by the liquidate job, after its liquidations): keeps each in-house perp market's stored price recent. PerpMarket measures a hold (feed halted,
// token delisted) from `lastPriceAt`, the feed time of the last price it recorded, and only trades record one. A
// market with open positions and no trades for a week that is then delisted would start its HELD_GRACE a week in the
// past and become settleable at once, at a week-old price. poke() records the current Valuer price and its time.
//
// Cheap by design: a market is poked only when it has open positions, its stored price is older than
// KEEPER_PERP_POKE_AGE_S (default 1 h) and the Valuer has a newer feed time to record (so a closed market or a
// delisted token, whose feed does not move, costs reads only, never a transaction every pass).
// v2 (review V2-L1): a market whose Valuer reverts (feed broken, token delisted) measures its hold from the later of
// lastPriceAt and `unpricedSince`, which only a state-changing call records (a delisted token uses its delistedAt).
// So when the Valuer reverts and nothing has recorded it yet, one poke starts that clock (once: the market then
// holds unpricedSince until the Valuer answers again); a recent lastPrice also means settleHeld settles at a recent price.
// Isolation: each market is its own try/catch; one failing market is a note and never stops the others.
import type { Address } from "viem";
import { perpMarketKeeperAbi, valuerAbi } from "@/abi/keeper";
import { chainNow, simulate, type Ctx, type JobResult } from "@/keeper/context";

export const DEFAULT_PERP_POKE_AGE_S = 3600;

export type PokeView = {
  openPositions: bigint;
  lastPriceAt: bigint;
  now: bigint;
  feedUpdatedAt: bigint | null;
  maxAge: bigint;
  /** PerpMarket.unpricedSince, read only when the Valuer reverts (0 = not recorded yet). */
  unpricedSince?: bigint | undefined;
};

/** Whether poke() is worth a transaction. Pure. */
export function pokeDecision(v: PokeView): { poke: true } | { poke: false; reason: string } {
  if (v.openPositions === 0n) return { poke: false, reason: "no open positions" };
  if (v.now <= v.lastPriceAt + v.maxAge) return { poke: false, reason: "price is recent" };
  if (v.feedUpdatedAt === null) {
    if ((v.unpricedSince ?? 0n) === 0n) return { poke: true }; // records when the Valuer started reverting
    return { poke: false, reason: "the Valuer does not answer and the market already recorded since when" };
  }
  if (v.feedUpdatedAt <= v.lastPriceAt) return { poke: false, reason: "the feed has nothing newer (market closed)" };
  return { poke: true };
}

export async function runPerpPoke(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "perp-poke", ok: true, actions: 0, notes: [] };
  const markets = ctx.dep.perpMarkets ?? [];
  if (markets.length === 0) return res;
  const maxAge = BigInt(ctx.perpPokeAgeS ?? DEFAULT_PERP_POKE_AGE_S);
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = [], abi: any = perpMarketKeeperAbi) =>
    ctx.pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;
  const now = await chainNow(ctx);
  for (const market of markets) {
    try {
      const openPositions = BigInt(await read<bigint>(market, "openPositionCount"));
      if (openPositions === 0n) continue;
      const lastPriceAt = BigInt(await read<bigint>(market, "lastPriceAt"));
      if (now <= lastPriceAt + maxAge) continue;
      const [valuer, underlying] = await Promise.all([read<Address>(market, "valuer"), read<Address>(market, "underlying")]);
      let feedUpdatedAt: bigint | null;
      let unpricedSince: bigint | undefined;
      try {
        feedUpdatedAt = BigInt((await read<{ updatedAt: bigint }>(valuer, "quote", [underlying], valuerAbi)).updatedAt);
      } catch {
        feedUpdatedAt = null; // the market itself falls back to its stored price here
        unpricedSince = BigInt(await read<bigint>(market, "unpricedSince"));
      }
      const d = pokeDecision({ openPositions, lastPriceAt, now, feedUpdatedAt, maxAge, unpricedSince });
      if (!d.poke) {
        res.notes.push(`${market}: not poked, ${d.reason}`);
        continue;
      }
      const sim = await simulate(ctx, market, perpMarketKeeperAbi as any, "poke", []);
      if (!sim.ok) {
        res.ok = false;
        res.notes.push(`${market}: poke reverts ${sim.errorName}`);
        continue;
      }
      await ctx.sender.sendCall(market, perpMarketKeeperAbi as any, "poke", [], "perp.poke");
      res.actions++;
    } catch (err) {
      res.ok = false;
      res.notes.push(`${market}: failed (${String((err as Error)?.message ?? err).split("\n")[0]})`);
    }
  }
  return res;
}
