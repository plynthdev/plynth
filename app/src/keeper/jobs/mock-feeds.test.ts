// refresh-mock-feeds: the pure parts (answer conversion, the post/keep-alive/skip decision, deployment parsing,
// pool math). The anvil test (mock-feeds.anvil.test.ts) runs the job against a real TestnetKit deployment.
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { loadConfig } from "@/config";
import { JOBS } from "@/keeper/keeper";
import { mockFeedDeployment } from "@/keeper/context";
import { divergenceBps, hasRealFeed, isqrt, mockAnswerFor, priceAt, refreshDecision, sqrtPriceX96For, swapToPrice, type RealFeed } from "./mock-feeds";

const E18 = 10n ** 18n;
const real = (o: Partial<RealFeed> = {}): RealFeed => ({ answer: 370_44800000n, decimals: 8, updatedAt: 1_000n, multiplier: E18, mainnetNow: 1_100n, ...o });

/** Deterministic PRNG (mulberry32) so the fuzz loops are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randBig = (r: () => number, bits: number) => {
  let x = 0n;
  for (let i = 0; i < bits; i += 30) x = (x << 30n) | BigInt(Math.floor(r() * 2 ** 30));
  return x & ((1n << BigInt(bits)) - 1n);
};

describe("mockAnswerFor", () => {
  test("per-share mock: real per-token answer divided by the real uiMultiplier", () => {
    // SPY on 2026-10-02: 770.712 per token, multiplier 1.001718 -> 769.39018766 per share.
    const a = mockAnswerFor(real({ answer: 770_71200000n, multiplier: 1_001718000000000000n }), 8, true);
    expect(a).toBe((770_71200000n * E18 + 1_001718000000000000n / 2n) / 1_001718000000000000n);
    expect(a).toBe(769_39018766n); // 769.39018766
  });

  test("per-token mock (multiplier embedded): answer unchanged; decimals rescaled", () => {
    expect(mockAnswerFor(real(), 8, false)).toBe(370_44800000n);
    expect(mockAnswerFor(real(), 18, false)).toBe(370_448n * 10n ** 15n);
    expect(mockAnswerFor(real({ answer: 123_456789n, decimals: 6 }), 8, false)).toBe(123_45678900n);
  });

  test("multiplier 1.0 leaves a per-share answer unchanged; rounds to nearest", () => {
    expect(mockAnswerFor(real(), 8, true)).toBe(370_44800000n);
    expect(mockAnswerFor(real({ answer: 5n, decimals: 1 }), 0, false)).toBe(1n); // 0.5 -> 1
    expect(mockAnswerFor(real({ answer: 4n, decimals: 1 }), 0, false)).toBe(0n); // 0.4 -> 0
  });

  test("refuses a non-positive answer or a zero multiplier", () => {
    expect(() => mockAnswerFor(real({ answer: 0n }), 8, true)).toThrow();
    expect(() => mockAnswerFor(real({ answer: -1n }), 8, false)).toThrow();
    expect(() => mockAnswerFor(real({ multiplier: 0n }), 8, true)).toThrow();
  });

  test("fuzz: per-share x multiplier recovers the per-token answer within one unit of rounding", () => {
    const r = rng(34);
    for (let i = 0; i < 2000; i++) {
      const answer = 1n + randBig(r, 48); // up to ~2.8e14 = $2.8M at 8 dp
      const multiplier = E18 + randBig(r, 58) % (2n * E18); // 1.0 .. 3.0
      const share = mockAnswerFor(real({ answer, multiplier }), 8, true);
      const back = (share * multiplier) / E18;
      const err = back > answer ? back - answer : answer - back;
      expect(err <= multiplier / E18 + 1n).toBe(true);
    }
  });
});

describe("refreshDecision", () => {
  const base = { intervalS: 600, keepAlive: true, realStaleS: 86_400 };
  test("mock younger than the interval: skip, read nothing", () => {
    expect(refreshDecision({ ...base, mockAge: 599n, real: real() })).toEqual({ action: "skip", reason: "fresh" });
  });
  test("real feed fresh: track it", () => {
    expect(refreshDecision({ ...base, mockAge: 600n, real: real() })).toEqual({ action: "track" });
    expect(refreshDecision({ ...base, keepAlive: false, mockAge: 600n, real: real({ updatedAt: 0n, mainnetNow: 86_400n }) })).toEqual({ action: "track" });
  });
  test("real feed stale (off-hours): keep-alive with its last answer, or skip when keep-alive is off", () => {
    const stale = real({ updatedAt: 0n, mainnetNow: 86_401n });
    expect(refreshDecision({ ...base, mockAge: 1_800n, real: stale })).toEqual({ action: "keep_alive", source: "real" });
    expect(refreshDecision({ ...base, keepAlive: false, mockAge: 1_800n, real: stale })).toEqual({ action: "skip", reason: "real_stale_no_keep_alive" });
  });
  test("mainnet read failed: keep-alive with the mock's own answer, or skip when keep-alive is off", () => {
    expect(refreshDecision({ ...base, mockAge: 1_800n, })).toEqual({ action: "keep_alive", source: "mock" });
    expect(refreshDecision({ ...base, keepAlive: false, mockAge: 1_800n, })).toEqual({ action: "skip", reason: "read_failed_no_keep_alive" });
  });
});

describe("mockFeedDeployment (deployment file)", () => {
  const stocks = {
    mTSLA: { token: "0x00000000000000000000000000000000000000a1", feed: "0x00000000000000000000000000000000000000f1", poolId: `0x${"11".repeat(32)}`, fee: 3000, currency0: "0x00000000000000000000000000000000000000a1", currency1: "0x00000000000000000000000000000000000000c0" },
    mSPY: { token: "0x00000000000000000000000000000000000000a2", feed: "0x00000000000000000000000000000000000000f2" },
    Custom: { token: "0x00000000000000000000000000000000000000a3", feed: "0x00000000000000000000000000000000000000f3", underlying: "NVDA" },
  };
  test("TestnetKit file: flag true, underlying from the symbol, pool fields parsed", () => {
    const m = mockFeedDeployment({ chainId: 46630, mockFeeds: true, usdg: "0x00000000000000000000000000000000000000c0", stockRouter: "0x00000000000000000000000000000000000000b0", stocks } as never);
    expect(m.flag).toBe(true);
    expect(m.stocks.map((s) => [s.symbol, s.underlying])).toEqual([["mTSLA", "TSLA"], ["mSPY", "SPY"], ["Custom", "NVDA"]]);
    expect(m.stocks[0]!.fee).toBe(3000);
    expect(m.stocks[0]!.poolId).toBe(`0x${"11".repeat(32)}`);
    expect(m.stocks[1]!.poolId).toBeUndefined();
    expect(m.router).toBe(getAddress("0x00000000000000000000000000000000000000b0"));
  });
  test("old file without the flag still parses (flag undefined); explicit false is kept", () => {
    expect(mockFeedDeployment({ chainId: 46630, stocks } as never).flag).toBeUndefined();
    expect(mockFeedDeployment({ chainId: 46630, mockFeeds: false, stocks } as never).flag).toBe(false);
  });
  test("stocks without a feed (LocalConsumer-style token-only entries) are left out; no stocks is fine", () => {
    expect(mockFeedDeployment({ chainId: 31337, stocks: { mTSLA: { token: "0x00000000000000000000000000000000000000a1" } } } as never).stocks).toEqual([]);
    expect(mockFeedDeployment({ chainId: 31337 } as never).stocks).toEqual([]);
  });
});

describe("mainnet feed table", () => {
  test("every kit stock has a real feed; QCOM has none", () => {
    for (const s of ["TSLA", "AAPL", "SPY"]) expect(hasRealFeed(s)).toBe(true);
    expect(hasRealFeed("QCOM")).toBe(false);
    expect(hasRealFeed("NOPE")).toBe(false);
  });
});

describe("pool math", () => {
  test("isqrt is floor(sqrt(n)) (fuzz)", () => {
    const r = rng(7);
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 2n ** 192n, 2n ** 255n]) {
      const s = isqrt(n);
      expect(s * s <= n && (s + 1n) * (s + 1n) > n).toBe(true);
    }
    for (let i = 0; i < 2000; i++) {
      const n = randBig(r, 1 + Math.floor(r() * 255));
      const s = isqrt(n);
      expect(s * s <= n && (s + 1n) * (s + 1n) > n).toBe(true);
    }
  });

  test("priceAt(sqrtPriceX96For(p)) == p within 1e-9 relative, both currency orders (fuzz)", () => {
    const r = rng(11);
    for (let i = 0; i < 1000; i++) {
      const p = (1n + randBig(r, 40)) * 10n ** 12n; // $0.000001 .. ~$1.1M per token
      for (const usdgIs0 of [true, false]) {
        const back = priceAt(sqrtPriceX96For(p, 6, 18, usdgIs0), 6, 18, usdgIs0);
        expect((back > p ? back - p : p - back) * 10n ** 9n <= p).toBe(true);
      }
    }
  });

  test("swapToPrice: direction follows the target and the input moves exactly that far (fee-free check)", () => {
    const L = 10n ** 20n;
    const sp = sqrtPriceX96For(250n * E18, 6, 18, true);
    const up = sqrtPriceX96For(200n * E18, 6, 18, true); // cheaper token -> more tokens per USDG -> sqrtP up
    const down = sqrtPriceX96For(300n * E18, 6, 18, true);
    expect(up > sp && down < sp).toBe(true);
    const a = swapToPrice(sp, up, L, 0);
    expect(a.zeroForOne).toBe(false);
    // Moving sqrtP by amount1 / L (X96): recompute the price the input lands on.
    const landed = sp + (a.amountIn * 2n ** 96n) / L;
    expect(landed >= up && landed - up <= 2n ** 96n / L + 1n).toBe(true);
    const b = swapToPrice(sp, down, L, 0);
    expect(b.zeroForOne).toBe(true);
    const landed0 = (L * 2n ** 96n * sp) / (L * 2n ** 96n + b.amountIn * sp);
    expect(landed0 <= down && down - landed0 <= 1n + down / 10n ** 15n).toBe(true);
  });

  test("swapToPrice grosses the input up by the fee", () => {
    const sp = 2n ** 96n;
    const t = sp + 2n ** 90n;
    expect(swapToPrice(sp, t, 10n ** 18n, 3000).amountIn).toBe((swapToPrice(sp, t, 10n ** 18n, 0).amountIn * 1_000_000n + 996_999n) / 997_000n);
    expect(() => swapToPrice(sp, t, 0n, 3000)).toThrow();
  });

  test("divergenceBps is symmetric in direction", () => {
    expect(divergenceBps(101n, 100n)).toBe(100n);
    expect(divergenceBps(99n, 100n)).toBe(100n);
    expect(divergenceBps(100n, 100n)).toBe(0n);
  });
});

describe("wiring", () => {
  test("refresh-mock-feeds runs first in a pass, before anything that trades", () => {
    expect(JOBS[0]![0]).toBe("refresh-mock-feeds");
    expect(JOBS.findIndex(([n]) => n === "refresh-mock-feeds")).toBeLessThan(JOBS.findIndex(([n]) => n === "execute"));
  });
  test("config defaults: every 600 s, keep-alive on, stale after a day, align beyond 50 bps", () => {
    const c = loadConfig({});
    expect([c.KEEPER_MOCK_FEED_INTERVAL_S, c.KEEPER_MOCK_FEED_KEEP_ALIVE, c.KEEPER_MOCK_FEED_REAL_STALE_S, c.KEEPER_MOCK_FEED_ALIGN_BPS]).toEqual([600, true, 86_400, 50]);
    expect(loadConfig({ KEEPER_MOCK_FEED_KEEP_ALIVE: "0" }).KEEPER_MOCK_FEED_KEEP_ALIVE).toBe(false);
    expect(() => loadConfig({ KEEPER_MOCK_FEED_INTERVAL_S: "0" })).toThrow();
  });
});
