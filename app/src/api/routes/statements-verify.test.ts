// Audit L-15: POST /v1/statements/verify turned one unauthenticated request into a full-history getLogs scan per
// disclosed note (up to 256 notes): thousands of RPC calls. Now the API caps a bundle at 32 notes, reads the pool's
// history from a cached, incremental index (concurrent requests share one scan) and the route is in the heavy
// rate-limit bucket. A fake RPC counts the calls.
import { beforeAll, describe, expect, test } from "bun:test";
import { commitmentOf, initVault, NoteTree, randomField, toBytes32 } from "@plynth/sdk/vault";
import { verifyDisclosure } from "@plynth/sdk/statements";
import { getAddress, type Hex, type PublicClient } from "viem";
import { BlockTimes, createApp, type Deps } from "@/api";
import { API_MAX_DISCLOSED_NOTES, PoolEventCache, verifyStatementBundle } from "./statements";

const POOL = getAddress("0x00000000000000000000000000000000000000b1");
const ASSET = getAddress("0x00000000000000000000000000000000000070c1");
const DEPLOY = 1_000_000n;
const HEAD = 2_000_000n; // a million blocks of history: 21 getLogs ranges of 50,000

let bundleOf: (n: number) => unknown;
let rootValue: bigint;

beforeAll(async () => {
  await initVault();
  const tree = new NoteTree();
  const notes = Array.from({ length: 40 }, (_, i) => ({ raw: BigInt(100 + i), ownerPk: 7n, blinding: randomField() }));
  const cs = notes.map((n) => commitmentOf(BigInt(ASSET), n.raw, n.ownerPk, n.blinding));
  for (const c of cs) tree.insert(c);
  rootValue = tree.root();
  bundleOf = (n) => ({
    version: 1,
    kind: "plynth.disclosure",
    chainId: 31337,
    pool: POOL,
    period: { fromBlock: "1500000", toBlock: "1900000" },
    root: toBytes32(rootValue),
    notes: notes.slice(0, n).map((x, i) => ({
      asset: ASSET,
      raw: x.raw.toString(),
      ownerPk: toBytes32(x.ownerPk),
      blinding: toBytes32(x.blinding),
      leafIndex: i,
      path: tree.path(i).map(toBytes32),
      nullifier: toBytes32(BigInt(i + 1)),
    })),
  });
});

/** RootUpdated at block 1,200,000; nullifier 1 spent at 1,800,000 (inside the period), 2 at 1,950,000 (after it). */
function fakePub() {
  const calls = { getLogs: 0 };
  const pub = {
    getChainId: async () => 31337,
    getBlockNumber: async () => HEAD,
    getLogs: async (q: { event: { name: string }; args?: { nullifier?: Hex | Hex[] }; fromBlock: bigint; toBlock: bigint }) => {
      calls.getLogs++;
      const inRange = (b: bigint) => b >= q.fromBlock && b <= q.toBlock;
      if (q.event.name === "RootUpdated") return inRange(1_200_000n) ? [{ blockNumber: 1_200_000n, logIndex: 0, args: { root: toBytes32(rootValue) } }] : [];
      if (q.event.name === "NullifierSpent") {
        const want = q.args?.nullifier === undefined ? null : [q.args.nullifier].flat();
        return [
          { blockNumber: 1_800_000n, logIndex: 0, args: { nullifier: toBytes32(1n) } },
          { blockNumber: 1_950_000n, logIndex: 0, args: { nullifier: toBytes32(2n) } },
        ].filter((l) => inRange(l.blockNumber) && (!want || want.includes(l.args.nullifier as Hex)));
      }
      throw new Error(q.event.name);
    },
  } as unknown as PublicClient;
  return { pub, calls };
}

const depsFor = (pub: PublicClient): Deps => ({ chainId: 31337, pub, db: {} as never, dep: { shieldedPool: POOL, deployBlock: DEPLOY } as never, blockTimes: new BlockTimes(pub) });

describe("audit L-15: bounded statement verification", () => {
  test("before (the SDK's per-note scan is gone too): 32 notes with nullifiers cost one pass, not one per note", async () => {
    const { pub, calls } = fakePub();
    const v = await verifyDisclosure(pub, bundleOf(32), { pool: POOL, deployBlock: DEPLOY });
    expect(v.ok).toBe(true);
    // root scan (backwards, finds it in its 15th range) + one nullifier pass of 21 ranges; it was 21 per note (672)
    expect(calls.getLogs).toBeLessThanOrEqual(40);
  });

  test("API: the first request backfills the index once; later requests make no historical getLogs at all", async () => {
    const { pub, calls } = fakePub();
    const cache = new PoolEventCache(pub, POOL, DEPLOY);
    const d = depsFor(pub);
    const v = await verifyStatementBundle(d, bundleOf(32), cache);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.notes.slice(0, 3).map((n) => n.nullifierStatus)).toEqual(["spent", "spent-after-period", "unspent"]);
    const first = calls.getLogs;
    expect(first).toBe(42); // RootUpdated + NullifierSpent, 21 ranges of 50,000 each, once
    for (let i = 0; i < 5; i++) expect((await verifyStatementBundle(d, bundleOf(32), cache)).ok).toBe(true);
    expect(calls.getLogs).toBe(first);
    // concurrent requests share one scan
    const { pub: p2, calls: c2 } = fakePub();
    const cache2 = new PoolEventCache(p2, POOL, DEPLOY);
    await Promise.all(Array.from({ length: 8 }, () => verifyStatementBundle(depsFor(p2), bundleOf(4), cache2)));
    expect(c2.getLogs).toBe(42);
  });

  test("API: more than 32 notes is refused before any RPC call", async () => {
    const { pub, calls } = fakePub();
    const v = await verifyStatementBundle(depsFor(pub), bundleOf(API_MAX_DISCLOSED_NOTES + 1), new PoolEventCache(pub, POOL, DEPLOY));
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain(`notes must be 1..${API_MAX_DISCLOSED_NOTES} entries`);
    expect(calls.getLogs).toBe(0);
  });

  test("the route is in the heavy rate-limit bucket", async () => {
    const { pub } = fakePub();
    const app = createApp(depsFor(pub), { ipOf: () => "198.51.100.77", rateLimit: { heavyPerMinute: 2 } });
    const post = () => app.request("/v1/statements/verify", { method: "POST", body: JSON.stringify(bundleOf(1)) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });
});

