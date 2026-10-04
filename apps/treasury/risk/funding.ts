// Funding-sign watch: for every perp position, is our side paying funding, and did that flip since the last
// look? A hedge short that starts paying funding is carry going the wrong way: the hedge/basis desks (todo 29)
// and humans want to know before it compounds.
import type { Address } from "viem";

export type FundingRead = {
  venue: Address;
  underlying: Address;
  ourSide: "long" | "short";
  /** Signed rate, 1e18 fraction of size per second: > 0 longs pay shorts, < 0 shorts pay longs, 0 none. */
  ratePerSecond: bigint;
};

export type FundingSign = FundingRead & {
  wePay: boolean;
  ratePerHourBps: number; // |rate| x 3600 in bps of size
};

export type FundingEvent = { kind: "adverse" | "flip"; key: string; now: FundingSign; before: FundingSign | null };

const keyOf = (r: FundingRead) => `${r.venue.toLowerCase()}:${r.underlying.toLowerCase()}`;

export function classify(r: FundingRead): FundingSign {
  const abs = r.ratePerSecond < 0n ? -r.ratePerSecond : r.ratePerSecond;
  const wePay = r.ratePerSecond === 0n ? false : (r.ratePerSecond > 0n) === (r.ourSide === "long");
  return { ...r, wePay, ratePerHourBps: Number((abs * 3600n * 10_000n) / 10n ** 18n) };
}

/** Remembers the last sign per (venue, underlying) and reports when we start paying ("adverse") and when the
 *  funding direction flips at all ("flip"). */
export class FundingWatch {
  private last = new Map<string, FundingSign>();

  update(reads: FundingRead[]): { signs: FundingSign[]; events: FundingEvent[] } {
    const events: FundingEvent[] = [];
    const seen = new Set<string>();
    const signs = reads.map(classify);
    for (const s of signs) {
      const k = keyOf(s);
      seen.add(k);
      const prev = this.last.get(k) ?? null;
      const sign = (x: bigint) => (x > 0n ? 1 : x < 0n ? -1 : 0);
      if (prev && sign(prev.ratePerSecond) !== 0 && sign(s.ratePerSecond) !== 0 && sign(prev.ratePerSecond) !== sign(s.ratePerSecond)) {
        events.push({ kind: "flip", key: k, now: s, before: prev });
      }
      if (s.wePay && !(prev?.wePay ?? false)) events.push({ kind: "adverse", key: k, now: s, before: prev });
      this.last.set(k, s);
    }
    for (const k of [...this.last.keys()]) if (!seen.has(k)) this.last.delete(k); // position closed
    return { signs, events };
  }
}

/** PerpMarket.fundingRate() returns (rate, longsPay); fold it into one signed rate. */
export function signedRate(rate: bigint, longsPay: boolean): bigint {
  return longsPay ? rate : -rate;
}
