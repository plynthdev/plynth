// Review v3, R3-SVC-1: the statement parser's worker pool was one global pool of 2 slots answering 503 at once. Fresh
// wallets on a few /64s kept both busy, honest imports got 503, and each refusal still used one of the wallet's 10
// imports per hour. Now each client /64 and wallet has its own slot in a larger pool with a short line, workers are
// kept warm, and a busy refusal gives the quotas back. (PoC: review3/import-slots.test.ts, now asserting the safe side.)
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sha256Hex } from "@/keeper";
import { BlockTimes, createApp, roundupMessage, roundupRoutes } from "@/api";
import { MAX_STATEMENT_BYTES } from "@/keeper/sources/statement";
import { ParseBusyError, ParsePool } from "@/keeper/sources/statement-offthread";

const CHAIN = 31337;
const noChain = new Proxy({}, { get: () => () => Promise.resolve(1n) }) as any;
const stubDb = { execute: async () => [{ n: 0 }] } as any; // the route answers 500 after a successful parse (stub db)

async function signedImport(content: string, w = privateKeyToAccount(generatePrivateKey())) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await w.signMessage({ message: roundupMessage({ action: "import", user: w.address, chainId: CHAIN, subject: sha256Hex(content), issuedAt }) });
  return JSON.stringify({ user: w.address, issuedAt, signature, content, format: "csv" });
}
function appWith(pool: ParsePool, ipOf: () => string) {
  const roundups = roundupRoutes({ chainId: CHAIN, db: stubDb, ipOf, parsePool: pool });
  const app = createApp({ chainId: CHAIN, pub: noChain, db: stubDb, dep: {} as any, blockTimes: new BlockTimes(noChain) }, { roundups, ipOf: () => "198.51.100.1" });
  return (body: string) => app.request("/v1/roundups/import", { method: "POST", headers: { "content-type": "application/json" }, body });
}
const bomb = ",".repeat(MAX_STATEMENT_BYTES - 1000); // the slowest 2 MB shape (a comma storm)
const honestCsv = "date,description,amount\n2026-10-01,coffee,-3.40\n";

describe("R3-SVC-1: honest imports are not starved by a crowd of fresh wallets", () => {
  test("two attacker parses in flight: the honest import is parsed, not 503", async () => {
    let ip = 0;
    const pool = new ParsePool();
    const post = appWith(pool, () => `2001:db8:${(ip++).toString(16)}::1`); // one /64 per request
    const [b1, b2, h] = await Promise.all([signedImport(bomb), signedImport(bomb), signedImport(honestCsv)]);
    const a1 = post(b1);
    const a2 = post(b2);
    await Bun.sleep(40);
    const hr = await post(h);
    await Promise.all([a1, a2]);
    pool.close();
    expect(hr.status).not.toBe(503);
    expect(hr.status).not.toBe(429);
  }, 60_000);

  test("sustained tiny imports at 50/s from fresh /64s: no honest import is refused busy", async () => {
    let ip = 0;
    const pool = new ParsePool();
    const post = appWith(pool, () => `2001:db8:${(ip++).toString(16)}::1`);
    const bodies = await Promise.all(Array.from({ length: 160 }, () => signedImport(",".repeat(1000))));
    const honest = await Promise.all(Array.from({ length: 10 }, () => signedImport(honestCsv)));
    const inflight: (Response | Promise<Response>)[] = [];
    const honestStatus: number[] = [];
    for (let i = 0; i < bodies.length; i++) {
      inflight.push(post(bodies[i]!));
      await Bun.sleep(20);
      if (i % 16 === 15) honestStatus.push((await post(honest[(i - 15) / 16]!)).status);
    }
    await Promise.all(inflight);
    pool.close();
    expect(honestStatus.filter((s) => s === 503)).toEqual([]);
  }, 60_000);

  test("busy refusals (503) do not burn the wallet's 10-per-hour import quota", async () => {
    let ip = 0;
    const pool = new ParsePool({ max: 1, waitMs: 0 }); // forced busy: one worker, no line
    const post = appWith(pool, () => `2001:db8:${(ip++).toString(16)}::1`);
    const w = privateKeyToAccount(generatePrivateKey());
    const body = await signedImport(honestCsv, w);
    let stop = false;
    const hold = async () => {
      while (!stop) await pool.parse(bomb, { format: "csv" }, { keys: ["attacker"] }).catch(() => Bun.sleep(1));
    };
    const holder = hold();
    await Bun.sleep(30);
    const during: number[] = [];
    for (let i = 0; i < 12; i++) during.push((await post(body)).status);
    stop = true;
    await holder;
    const after = (await post(body)).status;
    pool.close();
    expect(during.filter((s) => s === 503).length).toBeGreaterThanOrEqual(10);
    expect(during).not.toContain(429); // 12 refusals, none charged against the 10 per hour
    expect(after).not.toBe(429);
    expect(after).not.toBe(503);
  }, 60_000);
});

describe("ParsePool", () => {
  test("one parse at a time per key: a second one from the same wallet is refused, another wallet is not", async () => {
    const pool = new ParsePool();
    const first = pool.parse(bomb, { format: "csv" }, { keys: ["user:a"] }).catch(() => null); // no header: refused after parsing
    const same = await pool.parse(honestCsv, { format: "csv" }, { keys: ["user:a"] }).catch((e) => e);
    const other = await pool.parse(honestCsv, { format: "csv" }, { keys: ["user:b"] });
    await first;
    pool.close();
    expect(same).toBeInstanceOf(ParseBusyError);
    expect(other.rows).toHaveLength(1);
  }, 30_000);

  test("a full pool queues the next request instead of refusing it, and warm workers are reused", async () => {
    const pool = new ParsePool({ max: 1, waitMs: 5_000 });
    const t0 = performance.now();
    const [a, b] = await Promise.all([pool.parse(bomb, { format: "csv" }).catch((e) => e), pool.parse(honestCsv, { format: "csv" })]);
    expect(a).toBeInstanceOf(Error); // the bomb has no header row; what matters is that b waited for the worker
    expect(b.rows).toHaveLength(1);
    expect(pool.stats).toEqual({ running: 0, waiting: 0, idle: 1 });
    const t1 = performance.now();
    await pool.parse(honestCsv, { format: "csv" }); // a warm worker: no worker start
    expect(performance.now() - t1).toBeLessThan(performance.now() - t0);
    pool.close();
  }, 30_000);
});
