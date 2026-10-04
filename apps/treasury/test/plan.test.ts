import { describe, expect, test } from "bun:test";
import { chunk, equityTargetBps, maxOrderUsd, planCash, planEquity, USDG_TO_WAD, WAD, weightBps, type EquityToken, type PolicyView } from "../desks/plan";

const BALANCED: PolicyView = {
  cash: { minBps: 4000, maxBps: 7000 },
  equity: { minBps: 3000, maxBps: 6000 },
  perOrderCapUsd: 100_000n,
  perDayCapUsd: 500_000n,
  approvalAboveUsd: 50_000n,
  perNameFloatCapBps: 100,
};
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const C = "0x00000000000000000000000000000000000000cc" as const;
const tok = (token: `0x${string}`, heldUsd: number, price = 100, supplyTokens = 1e9): EquityToken => ({
  token,
  raw: (usd(heldUsd) * WAD) / usd(price),
  usd: usd(heldUsd),
  priceUsd: usd(price),
  decimals: 18,
  floatCapRaw: (BigInt(supplyTokens) * WAD * 100n) / 10_000n,
});

describe("chunk / caps", () => {
  test("chunk splits into max-size pieces with the remainder last", () => {
    expect(chunk(250n, 100n)).toEqual([100n, 100n, 50n]);
    expect(chunk(0n, 100n)).toEqual([]);
    expect(() => chunk(1n, 0n)).toThrow();
  });
  test("max order is min(perOrderCap, approvalAbove) less 1%: desks never need a board ticket", () => {
    expect(maxOrderUsd(BALANCED)).toBe(usd(49_500));
    expect(maxOrderUsd({ ...BALANCED, perOrderCapUsd: 10_000n })).toBe(usd(9_900));
  });
  test("weightBps floors", () => {
    expect(weightBps(1n, 3n)).toBe(3333);
    expect(weightBps(1n, 0n)).toBe(0);
  });
});

describe("cash desk: keep idle USDG >= 2% of NAV, sweep the rest, redeem when needed", () => {
  const base = { navUsd: usd(100_000), vaultAssetsUsdg: 0n, reserveBps: 200, sweepMinBps: 50, maxOrderUsd: usd(49_500) };
  test("sweeps everything above the reserve into the vault, in capped chunks", () => {
    const ops = planCash({ ...base, idleUsdg: 55_000_000000n });
    expect(ops.map((o) => o.action)).toEqual(["deposit", "deposit"]);
    expect(ops.reduce((a, o) => a + o.usdg, 0n)).toBe(53_000_000000n);
    expect(ops[0]!.usdg).toBe(49_500_000000n);
  });
  test("does not sweep dust below sweepMinBps", () => {
    expect(planCash({ ...base, idleUsdg: 2_400_000000n })).toEqual([]);
    expect(planCash({ ...base, idleUsdg: 2_500_000000n })).toEqual([{ action: "deposit", usdg: 500_000000n }]);
  });
  test("redeems the shortfall below the reserve", () => {
    expect(planCash({ ...base, idleUsdg: 500_000000n, vaultAssetsUsdg: 50_000_000000n })).toEqual([{ action: "redeem", usdg: 1_500_000000n }]);
  });
  test("redeems what the equity desk needs on top of the reserve, capped at what the vault holds", () => {
    expect(planCash({ ...base, idleUsdg: 2_000_000000n, vaultAssetsUsdg: 50_000_000000n, extraNeedUsdg: 5_000_000000n })).toEqual([{ action: "redeem", usdg: 5_000_000000n }]);
    expect(planCash({ ...base, idleUsdg: 0n, vaultAssetsUsdg: 1_000_000000n, extraNeedUsdg: 5_000_000000n })).toEqual([{ action: "redeem", usdg: 1_000_000000n }]);
  });
  test("nothing to do with zero NAV", () => {
    expect(planCash({ ...base, navUsd: 0n, idleUsdg: 0n })).toEqual([]);
  });
});

describe("equity desk: target weights inside the band", () => {
  test("default target is the middle of the equity band; board target is clamped into it", () => {
    expect(equityTargetBps(BALANCED.equity, {})).toBe(4500);
    expect(equityTargetBps(BALANCED.equity, { targetBps: 9000 })).toBe(6000);
    expect(equityTargetBps(BALANCED.equity, { targetBps: 100 })).toBe(3000);
    expect(equityTargetBps(BALANCED.equity, { targetBps: 4000 })).toBe(4000);
  });

  test("equal weights from all cash: three buys of 15% NAV each", () => {
    const p = planEquity(usd(100_000), [tok(A, 0), tok(B, 0), tok(C, 0)], BALANCED, 0n);
    expect(p.orders.map((o) => o.action)).toEqual(["buy", "buy", "buy"]);
    expect(p.orders.map((o) => o.amount)).toEqual([15_000_000000n, 15_000_000000n, 15_000_000000n]);
    expect(p.buyUsdg).toBe(45_000_000000n);
    expect(p.deferred).toEqual([]);
  });

  test("board-supplied weights split the equity target", () => {
    const p = planEquity(usd(100_000), [tok(A, 0), tok(B, 0)], BALANCED, 0n, { weights: { [A]: 2, [B.toUpperCase().replace("0X", "0x")]: 1 } });
    expect(p.targets[A]).toBe(usd(30_000));
    expect(p.targets[B]).toBe(usd(15_000));
  });

  test("names within driftBps of target are not traded", () => {
    const p = planEquity(usd(100_000), [tok(A, 14_500), tok(B, 15_400), tok(C, 15_000)], BALANCED, 0n);
    expect(p.orders).toEqual([]);
  });

  test("sells come before buys; sells are sized in raw units at the oracle price", () => {
    const p = planEquity(usd(100_000), [tok(A, 30_000, 200), tok(B, 0), tok(C, 15_000)], BALANCED, 0n);
    expect(p.orders.map((o) => `${o.action}:${o.token}`)).toEqual([`sell:${A}`, `buy:${B}`]);
    expect(p.orders[0]!.amount).toBe(75n * WAD); // $15k at $200
    expect(p.sellUsdg).toBe(14_850_000000n); // after 1% slippage allowance
  });

  test("orders above the max order size are split so none needs a board ticket", () => {
    const p = planEquity(usd(400_000), [tok(A, 0)], BALANCED, 0n);
    expect(p.orders.length).toBe(4);
    for (const o of p.orders) expect(o.usd <= maxOrderUsd(BALANCED)).toBe(true);
    expect(p.orders.reduce((a, o) => a + o.amount, 0n)).toBe(180_000_000000n);
  });

  test("orders beyond the 24h cap are deferred, not sent", () => {
    const p = planEquity(usd(100_000), [tok(A, 0), tok(B, 0), tok(C, 0)], BALANCED, usd(480_000));
    expect(p.orders.length).toBe(1);
    expect(p.deferred.length).toBe(2);
  });

  test("a name's target is clamped to its float cap (with margin)", () => {
    // Supply 1,000 tokens at $100: 1% = 10 tokens = $1,000 max, less 0.1% margin.
    const p = planEquity(usd(100_000), [tok(A, 0, 100, 1000), tok(B, 0)], BALANCED, 0n, { driftBps: 50 });
    expect(p.targets[A]).toBe(usd(999));
    expect(p.orders.find((o) => o.token === A)!.amount).toBe(999_000000n);
  });

  test("a zero-weight name is sold out entirely, dust included", () => {
    const t = tok(A, 10_000, 3);
    t.raw += 7n; // dust
    const p = planEquity(usd(100_000), [t, tok(B, 35_000)], BALANCED, 0n, { weights: { [B]: 1 } });
    const sold = p.orders.filter((o) => o.token === A && o.action === "sell").reduce((a, o) => a + o.amount, 0n);
    expect(sold).toBe(t.raw);
  });

  test("weights end inside the band after the planned orders (property)", () => {
    for (let i = 0; i < 200; i++) {
      const nav = 50_000 + Math.random() * 950_000;
      const held = [Math.random(), Math.random(), Math.random()].map((r) => r * nav * 0.3);
      const cash = nav - held.reduce((a, b) => a + b, 0);
      if (cash < 0) continue;
      const tokens = [tok(A, held[0]!), tok(B, held[1]!, 50), tok(C, held[2]!, 700)];
      const p = planEquity(usd(nav), tokens, { ...BALANCED, perDayCapUsd: 10n ** 12n }, 0n);
      let eq = tokens.reduce((a, t) => a + t.usd, 0n);
      for (const o of p.orders) eq += o.action === "buy" ? o.amount * USDG_TO_WAD : -o.usd;
      const w = weightBps(eq, usd(nav));
      expect(w).toBeGreaterThanOrEqual(3000);
      expect(w).toBeLessThanOrEqual(6000);
    }
  });
});
