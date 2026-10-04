// Hedge desk (todo 29): plan rules one by one, then a simulated week (168 hourly steps, seeded price walk,
// market hours 14:00-21:00 UTC Mon-Fri, feeds frozen otherwise, spot flows mid-week and at Friday's close).
// After every in-hours pass the net delta is inside the band; off-hours the desk never adds short size.
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { hedgeOnce, planHedge, shortOf, type HedgeInput } from "../desks/hedge";
import type { OrderRequest, PerpVenueClient } from "../venues/types";

const E18 = 10n ** 18n;
const SPY = "0x0000000000000000000000000000000000005b10" as Address;
const band = { minBps: 1000, maxBps: 4500 };
const cfg = { underlying: SPY };
const base = (x: Partial<HedgeInput>): HedgeInput => ({ navUsd: 1_000_000n * E18, stockUsd: 0n, perpDeltaUsd: 0n, band, offHours: false, shortTokens: 0n, priceUsd: 500n * E18, ...x });

describe("planHedge rules", () => {
  test("inside the band: nothing", () => {
    expect(planHedge(base({ stockUsd: 300_000n * E18 }), cfg)).toMatchObject({ action: "none", reason: "in_band", deltaBps: 3000 });
  });

  test("above the band: short back to the middle (27.5%)", () => {
    const d = planHedge(base({ stockUsd: 600_000n * E18 }), cfg);
    expect(d).toMatchObject({ action: "short_more", targetBps: 2750 });
    expect(d.tokens).toBe(((600_000n - 275_000n) * E18 * E18) / (500n * E18));
  });

  test("above the band off-hours: no new short (only reduce off-hours)", () => {
    expect(planHedge(base({ stockUsd: 600_000n * E18, offHours: true }), cfg)).toMatchObject({ action: "none", reason: "off_hours_only_reduce" });
  });

  test("below the band: reduce the short, also off-hours, never past zero", () => {
    const d = planHedge(base({ stockUsd: 300_000n * E18, perpDeltaUsd: -250_000n * E18, shortTokens: 500n * E18, offHours: true }), cfg);
    expect(d.action).toBe("reduce_short");
    expect(d.tokens).toBe(450n * E18); // (275k - 50k) / $500
    const capped = planHedge(base({ stockUsd: 0n, perpDeltaUsd: -50_000n * E18, shortTokens: 100n * E18 }), cfg);
    expect(capped).toMatchObject({ action: "reduce_short", tokens: 100n * E18 });
    expect(planHedge(base({ stockUsd: 50_000n * E18 }), cfg)).toMatchObject({ action: "none", reason: "below_band_no_short" });
  });

  test("dust is ignored", () => {
    expect(planHedge(base({ stockUsd: 460_000n * E18 }), { ...cfg, minTradeUsd: 200_000n * E18 })).toMatchObject({ action: "none", reason: "below_min_trade" });
  });
});

/** A venue whose fills happen at the simulation's price. */
class SimVenue implements PerpVenueClient {
  readonly kind = "inhouse" as const;
  readonly name = "sim";
  tokens = 0n; // signed
  orders: OrderRequest[] = [];
  constructor(public price: () => bigint) {}
  async funding() {
    return [];
  }
  async statement() {
    return { venue: this.name, ts: 0, positions: this.tokens ? [{ underlying: SPY, tokens: this.tokens }] : [], equityUsd: 0n };
  }
  async placeOrder(o: OrderRequest) {
    this.orders.push(o);
    if (o.side === "buy" && o.reduceOnly && o.tokens > -this.tokens) throw new Error("reduce past zero");
    this.tokens += o.side === "sell" ? -o.tokens : o.tokens;
    return { id: String(this.orders.length), status: "filled", tokens: o.tokens, side: o.side, underlying: o.underlying };
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("hedge keeps delta in band across a simulated week", () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      let price = 500n * E18;
      let spotTokens = 900n; // whole tokens of SPY spot ($450k: 45% of $1M at the start)
      let cash = 550_000n * E18;
      const venue = new SimVenue(() => price);
      const fills: bigint[] = [];
      let inHoursChecks = 0;
      let offHoursAdds = 0;
      const start = Date.UTC(2026, 9, 5, 0); // Monday 00:00 UTC
      for (let h = 0; h < 168; h++) {
        const t = new Date(start + h * 3_600_000);
        const day = t.getUTCDay();
        const open = day >= 1 && day <= 5 && t.getUTCHours() >= 14 && t.getUTCHours() < 21;
        if (open) {
          // +-1.5% hourly moves, a +4% gap on Wednesday's open.
          const move = BigInt(Math.round((r() * 3 - 1.5) * 100)) + (day === 3 && t.getUTCHours() === 14 ? 400n : 0n);
          price = (price * (10_000n + move)) / 10_000n;
        }
        // Flows: the equity desk buys 300 more tokens Wednesday 15:00; a redemption sells 700 at Friday's close.
        if (day === 3 && t.getUTCHours() === 15) {
          spotTokens += 300n;
          cash -= 300n * price;
        }
        if (day === 5 && t.getUTCHours() === 21) {
          spotTokens -= 700n;
          cash += 700n * price;
        }
        const stockUsd = spotTokens * price;
        const perp = (venue.tokens * price) / E18;
        const before = venue.tokens;
        const nav = cash + stockUsd; // perp PnL is margin-side; NAV moves with spot and cash here
        await hedgeOnce({ navUsd: nav, stockUsd, perpDeltaUsd: perp, band, offHours: !open, shortTokens: shortOf((await venue.statement()).positions, SPY), priceUsd: price }, cfg, venue, async (f) => {
          fills.push(f.tokens);
        });
        if (!open && venue.tokens < before) offHoursAdds++;
        if (open) {
          const d = Number(((stockUsd + (venue.tokens * price) / E18) * 10_000n) / nav);
          expect(d >= band.minBps && d <= band.maxBps, `h=${h} delta=${d}`).toBe(true);
          inHoursChecks++;
        }
      }
      expect(inHoursChecks).toBe(35);
      expect(offHoursAdds).toBe(0);
      expect(venue.orders.some((o) => o.side === "sell")).toBe(true); // it hedged
      expect(venue.orders.some((o) => o.side === "buy" && o.reduceOnly)).toBe(true); // and unwound after Friday's sale (off-hours)
      expect(venue.orders.every((o) => o.side === "sell" ? !o.reduceOnly : o.reduceOnly)).toBe(true); // never a long
      expect(fills.reduce((a, b) => a + b, 0n)).toBe(venue.tokens); // the ledger matches the venue
    });
  }
});
