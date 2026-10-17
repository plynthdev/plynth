// Job perp-poke: the pure decision, per-market isolation over a fake chain, wiring and the ABI slice.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, toFunctionSelector, type Address } from "viem";
import { perpMarketKeeperAbi } from "@/abi/keeper";
import type { Ctx } from "@/keeper/context";
import { JOBS } from "@/keeper/keeper";
import { ROOT } from "@/testing/keeper-helpers";
import { runLiquidate } from "./liquidate";
import { pokeDecision, runPerpPoke } from "./perp-poke";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const M1 = A(0x901), M2 = A(0x902), M3 = A(0x903);
const VALUER = A(0x800);
const NOW = 1_800_000_000n;

describe("pokeDecision", () => {
  const base = { openPositions: 2n, lastPriceAt: NOW - 7200n, now: NOW, feedUpdatedAt: NOW - 60n, maxAge: 3600n };
  test("open positions, an old stored price, a newer feed: poke", () => expect(pokeDecision(base).poke).toBe(true));
  test("no open positions: nothing to protect", () => expect(pokeDecision({ ...base, openPositions: 0n })).toMatchObject({ poke: false, reason: "no open positions" }));
  test("stored price younger than the max age", () => expect(pokeDecision({ ...base, lastPriceAt: NOW - 3600n }).poke).toBe(false));
  test("a reverting Valuer nobody recorded yet: one poke starts the hold clock (v2 unpricedSince)", () => {
    expect(pokeDecision({ ...base, feedUpdatedAt: null, unpricedSince: 0n }).poke).toBe(true);
  });
  test("market closed (feed not newer) or a Valuer revert already recorded: no transaction", () => {
    expect(pokeDecision({ ...base, feedUpdatedAt: NOW - 7200n })).toMatchObject({ poke: false, reason: expect.stringMatching(/closed/) });
    expect(pokeDecision({ ...base, feedUpdatedAt: null, unpricedSince: NOW - 600n })).toMatchObject({ poke: false, reason: expect.stringMatching(/already recorded/) });
  });
});

type M = { count: bigint; lastPriceAt: bigint; feed: bigint | "revert"; throws?: boolean; unpricedSince?: bigint };

function fakeCtx(markets: Record<string, M>, maxAge?: number) {
  const sent: string[] = [];
  const pub = {
    getBlock: async () => ({ timestamp: NOW }),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
      if (address === VALUER) {
        const m = markets[String(args[0])]!;
        if (m.feed === "revert") throw new Error("execution reverted: NoFeed");
        return { updatedAt: m.feed };
      }
      const m = markets[address]!;
      if (m.throws) throw new Error("rpc: connection reset\nstack");
      if (functionName === "openPositionCount") return m.count;
      if (functionName === "lastPriceAt") return m.lastPriceAt;
      if (functionName === "valuer") return VALUER;
      if (functionName === "underlying") return address; // the fake keys the Valuer by market
      if (functionName === "unpricedSince") return m.unpricedSince ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async () => ({ result: undefined }),
  };
  const sender = {
    sendCall: async (to: Address, _abi: unknown, fn: string) => {
      sent.push(`${fn}:${to}`);
      return { transactionHash: "0x01" };
    },
  };
  const ctx = { pub, sender, dep: { perpMarkets: Object.keys(markets) }, perpPokeAgeS: maxAge, log: () => {} } as unknown as Ctx;
  return { ctx, sent };
}

describe("runPerpPoke over a fake chain", () => {
  test("pokes only the stale market with open positions and a newer feed; a throwing market does not stop the next", async () => {
    const { ctx, sent } = fakeCtx({
      [M1]: { count: 1n, lastPriceAt: NOW - 7200n, feed: NOW - 30n, throws: true },
      [M2]: { count: 3n, lastPriceAt: NOW - 7200n, feed: NOW - 30n },
      [M3]: { count: 3n, lastPriceAt: NOW - 7200n, feed: "revert", unpricedSince: NOW - 900n },
    });
    const r = await runPerpPoke(ctx);
    expect(sent).toEqual([`poke:${M2}`]);
    expect(r.actions).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.notes.join("|")).toMatch(new RegExp(`${M1}: failed \\(rpc: connection reset\\)`));
    expect(r.notes.join("|")).toMatch(new RegExp(`${M3}: not poked, the Valuer does not answer and the market already recorded`));
  });

  test("fresh prices, empty markets and a closed market cost no transaction; the max age is configurable", async () => {
    const markets = {
      [M1]: { count: 1n, lastPriceAt: NOW - 600n, feed: NOW - 30n },
      [M2]: { count: 0n, lastPriceAt: 0n, feed: NOW },
      [M3]: { count: 2n, lastPriceAt: NOW - 90_000n, feed: NOW - 90_000n },
    };
    const a = fakeCtx(markets);
    expect((await runPerpPoke(a.ctx)).ok).toBe(true);
    expect(a.sent).toEqual([]);
    const b = fakeCtx(markets, 300);
    await runPerpPoke(b.ctx);
    expect(b.sent).toEqual([`poke:${M1}`]);
  });
});

describe("wiring", () => {
  test("the JOBS order is exactly the merged order (safety first, user-supplied spends last); poke rides on liquidate", () => {
    expect(JOBS.map(([n]) => n)).toEqual(["refresh-mock-feeds", "liquidate", "fee-push", "topups", "roundups", "sweep", "beacon", "execute", "deliver-quiet", "deliver-hidden", "spends"]);
  });

  test("runLiquidate runs the poke phase after its liquidations", async () => {
    const { ctx, sent } = fakeCtx({ [M2]: { count: 3n, lastPriceAt: NOW - 7200n, feed: NOW - 30n } });
    const pub = ctx.pub as any;
    const inner = pub.readContract;
    pub.readContract = async (q: any) => (q.functionName === "openPositions" ? [] : inner(q));
    const r = await runLiquidate(ctx);
    expect(sent).toEqual([`poke:${M2}`]);
    expect(r.job).toBe("liquidate");
    expect(r.actions).toBe(1);
  });

  test("ABI slice matches contracts/out (skips if not built)", () => {
    const f = join(ROOT, "contracts", "out", "PerpMarket.sol", "PerpMarket.json");
    if (!existsSync(f)) return console.warn(`skip: ${f} not built`);
    const all = new Set((JSON.parse(readFileSync(f, "utf8")).abi as any[]).filter((x) => x.type === "function").map((x) => toFunctionSelector(x)));
    for (const x of perpMarketKeeperAbi) if (x.type === "function") expect(all.has(toFunctionSelector(x))).toBe(true);
  });
});
