// Review v2, V2-L12: tRPC batching bypassed the L-13 heavy-route limit and the L-15 per-request bound. The heavy
// limiter matched only the start of the path, and one batched HTTP request ran every listed procedure: with
// heavyPerMinute 1, three requests ran 601 statements.verify. Batching is now refused.
import { expect, test } from "bun:test";
import { BlockTimes, createApp } from "@/api";

function deps() {
  const calls = { getBlockNumber: 0, getLogs: 0 };
  const pub = {
    getBlockNumber: async () => (calls.getBlockNumber++, 1000n),
    getChainId: async () => 31337,
    getLogs: async () => (calls.getLogs++, []),
    readContract: async () => 0n,
  } as any;
  const dep = { shieldedPool: "0x00000000000000000000000000000000000000a1", deployBlock: 1n, stocks: [] } as any;
  return { calls, d: { chainId: 31337, pub, db: {} as any, dep, blockTimes: new BlockTimes(pub) } };
}

const bundle = { v: 1, chainId: 31337, pool: "0x00000000000000000000000000000000000000a1", period: { fromBlock: "1", toBlock: "2" }, root: `0x${"00".repeat(31)}01`, notes: [] };

test("heavyPerMinute=1: batched requests run no procedure at all, and single heavy calls are limited", async () => {
  const { calls, d } = deps();
  const app = createApp(d, { ipOf: () => "203.0.113.5", rateLimit: { perMinute: 600, heavyPerMinute: 1 } });
  const N = 200;
  const names = ["tx.approveUsdg", ...Array(N).fill("statements.verify")].join(",");
  const body = Object.fromEntries(Array.from({ length: N + 1 }, (_, i) => [String(i), i === 0 ? { amount: "1" } : { bundle }]));
  const send = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await send(`/trpc/${names}?batch=1`)).status);
  // the comma form without ?batch, and ?batch with a single name, are refused too
  statuses.push((await send(`/trpc/${names}`)).status);
  statuses.push((await send(`/trpc/statements.verify?batch=1`)).status);
  expect(statuses).toEqual([400, 400, 400, 400, 400]);
  expect(calls.getBlockNumber).toBe(0);
  const single = async () => (await app.request(`/v1/statements/verify`, { method: "POST", body: JSON.stringify(bundle) })).status;
  await single();
  expect(await single()).toBe(429);
  expect(calls.getBlockNumber).toBeLessThanOrEqual(2);
});

test("an unbatched tRPC call still works", async () => {
  const { d } = deps();
  const app = createApp(d, { ipOf: () => "203.0.113.6" });
  const r = await app.request(`/trpc/meta.eligibility`);
  expect(r.status).toBe(200);
});
