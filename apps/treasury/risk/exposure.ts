// Per-venue and per-name exposure from what the chain reports (the PolicyGuard snapshot plus each venue's
// positions), measured against the policy's T2 limits. Pure: the service feeds it numbers it read.
import type { Address } from "viem";

const WAD = 10n ** 18n;

export type VenueRead = {
  venue: Address;
  equityUsd: bigint; // 1e18
  grossUsd: bigint; // 1e18, sum of |notional|
  stale: boolean;
  positions: { underlying: Address; tokens: bigint; usd: bigint }[]; // usd signed (+ long, - short)
};

export type SpotRead = { asset: Address; usd: bigint }; // Stock Tokens only

export type Limits = {
  netDeltaMinBps: number;
  netDeltaMaxBps: number;
  maxLeverageX10: number;
  perVenueCapBps: number;
};

export type VenueExposure = {
  venue: Address;
  equityUsd: bigint;
  grossUsd: bigint;
  weightBps: number; // venue equity / NAV
  leverageX10: number | null; // gross / equity x 10, null when equity is 0
  stale: boolean;
  overCap: boolean;
  overLeverage: boolean;
};

export type NameExposure = {
  underlying: Address;
  spotUsd: bigint;
  perpUsd: bigint; // signed
  netUsd: bigint; // signed
  weightBps: number; // net / NAV, signed
};

export type ExposureReport = {
  navUsd: bigint;
  netDeltaUsd: bigint;
  netDeltaBps: number;
  netDeltaInBand: boolean | null; // null when the policy has no overlay (T1)
  venues: VenueExposure[];
  names: NameExposure[];
};

const bps = (part: bigint, nav: bigint) => (nav === 0n ? 0 : Number((part * 10_000n) / nav));

export function computeExposure(navUsd: bigint, spot: SpotRead[], venues: VenueRead[], limits: Limits): ExposureReport {
  const names = new Map<string, NameExposure>();
  const name = (u: Address) => {
    const k = u.toLowerCase();
    let n = names.get(k);
    if (!n) {
      n = { underlying: u, spotUsd: 0n, perpUsd: 0n, netUsd: 0n, weightBps: 0 };
      names.set(k, n);
    }
    return n;
  };
  for (const s of spot) if (s.usd !== 0n) name(s.asset).spotUsd += s.usd;
  const outVenues: VenueExposure[] = venues.map((v) => {
    for (const p of v.positions) name(p.underlying).perpUsd += p.usd;
    const weightBps = bps(v.equityUsd, navUsd);
    const leverageX10 = v.equityUsd === 0n ? null : Number((v.grossUsd * 10n * WAD) / v.equityUsd / WAD);
    return {
      venue: v.venue,
      equityUsd: v.equityUsd,
      grossUsd: v.grossUsd,
      weightBps,
      leverageX10,
      stale: v.stale,
      overCap: v.equityUsd * 10_000n > BigInt(limits.perVenueCapBps) * navUsd,
      overLeverage: v.grossUsd > 0n && v.grossUsd * 10n > v.equityUsd * BigInt(limits.maxLeverageX10),
    };
  });
  let netDeltaUsd = 0n;
  for (const n of names.values()) {
    n.netUsd = n.spotUsd + n.perpUsd;
    n.weightBps = bps(n.netUsd, navUsd);
    netDeltaUsd += n.netUsd;
  }
  const netDeltaBps = bps(netDeltaUsd, navUsd);
  const t2 = limits.maxLeverageX10 > 0;
  return {
    navUsd,
    netDeltaUsd,
    netDeltaBps,
    netDeltaInBand: t2 ? netDeltaBps >= limits.netDeltaMinBps && netDeltaBps <= limits.netDeltaMaxBps : null,
    venues: outVenues,
    names: [...names.values()].sort((a, b) => (a.underlying.toLowerCase() < b.underlying.toLowerCase() ? -1 : 1)),
  };
}
