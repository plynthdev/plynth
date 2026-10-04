// Hedge desk (T2, rule-only): keeps the treasury's net delta (spot Stock Tokens + signed perp notional, over NAV)
// inside the policy's overlay band using perp SHORTS of one hedge underlying at one venue.
//   delta above max -> short more, back to the middle of the band (never off-hours: that is new risk);
//   delta below min -> reduce the short, back to the middle (allowed off-hours: it only reduces);
//   inside the band -> nothing.
// It never opens a long and never touches spot. The on-chain PolicyGuard re-checks every order (rule 5/6/7).
import type { Address } from "viem";
import type { PerpVenueClient, VenuePosition } from "@/treasury/venues/types";

const E18 = 10n ** 18n;

export type HedgeConfig = {
  underlying: Address; // the hedge instrument (e.g. the broadest index Stock Token the venue lists)
  minTradeUsd?: bigint; // USD 1e18 below which the desk does nothing (default $100)
  maxSlippageBps?: number; // protective bound on venue orders (default 50)
};

export type HedgeInput = {
  navUsd: bigint; // USD 1e18
  stockUsd: bigint; // spot Stock Tokens, USD 1e18
  perpDeltaUsd: bigint; // signed perp notional over every venue, USD 1e18
  band: { minBps: number; maxBps: number };
  offHours: boolean;
  shortTokens: bigint; // current hedge short of `underlying` at this desk's venue (>= 0)
  priceUsd: bigint; // Valuer price per token, USD 1e18
};

export type HedgeDecision = {
  action: "none" | "short_more" | "reduce_short";
  tokens: bigint;
  reason: string;
  deltaBps: number;
  targetBps: number;
};

const bps = (x: bigint, nav: bigint) => (nav === 0n ? 0 : Number((x * 10_000n) / nav));

export function planHedge(i: HedgeInput, cfg: HedgeConfig): HedgeDecision {
  const delta = i.stockUsd + i.perpDeltaUsd;
  const deltaBps = bps(delta, i.navUsd);
  const targetBps = Math.floor((i.band.minBps + i.band.maxBps) / 2);
  const out = (action: HedgeDecision["action"], tokens: bigint, reason: string): HedgeDecision => ({ action, tokens, reason, deltaBps, targetBps });
  if (i.navUsd === 0n || i.priceUsd === 0n) return out("none", 0n, "no_nav_or_price");
  if (deltaBps >= i.band.minBps && deltaBps <= i.band.maxBps) return out("none", 0n, "in_band");

  const target = (i.navUsd * BigInt(targetBps)) / 10_000n;
  const minTrade = cfg.minTradeUsd ?? 100n * E18;
  if (deltaBps > i.band.maxBps) {
    if (i.offHours) return out("none", 0n, "off_hours_only_reduce");
    const usd = delta - target;
    if (usd < minTrade) return out("none", 0n, "below_min_trade");
    return out("short_more", (usd * E18) / i.priceUsd, "delta_above_band");
  }
  // Below the band: buy back part of the short (spot buying is the equity desk's job).
  if (i.shortTokens === 0n) return out("none", 0n, "below_band_no_short");
  const usd = target - delta;
  if (usd < minTrade) return out("none", 0n, "below_min_trade");
  let tokens = (usd * E18) / i.priceUsd;
  if (tokens > i.shortTokens) tokens = i.shortTokens;
  return out("reduce_short", tokens, "delta_below_band");
}

export const shortOf = (positions: VenuePosition[], u: Address) => {
  const p = positions.find((x) => x.underlying.toLowerCase() === u.toLowerCase());
  return p && p.tokens < 0n ? -p.tokens : 0n;
};

export type FillSink = (f: { venue: string; underlying: Address; desk: "hedge" | "basis"; tokens: bigint; orderId: string }) => Promise<void>;

/** One hedge pass: plan from the inputs, place the order at the venue, record the fill in the ledger. */
export async function hedgeOnce(input: HedgeInput, cfg: HedgeConfig, venue: PerpVenueClient, record?: FillSink) {
  const d = planHedge(input, cfg);
  if (d.action === "none") return { decision: d };
  const res = await venue.placeOrder({
    underlying: cfg.underlying,
    side: d.action === "short_more" ? "sell" : "buy",
    tokens: d.tokens,
    reduceOnly: d.action === "reduce_short",
    maxSlippageBps: cfg.maxSlippageBps ?? 50,
  });
  await record?.({ venue: venue.name, underlying: cfg.underlying, desk: "hedge", tokens: res.side === "sell" ? -res.tokens : res.tokens, orderId: res.id });
  return { decision: d, order: res };
}
