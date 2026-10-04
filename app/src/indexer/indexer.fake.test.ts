import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@/testing/db";
import { parseAbiItem, type AbiEvent } from "viem";
import type { Stream } from "./handlers/streams";
import { healthApp } from "./health";
import { Indexer, REORG_REWIND } from "./indexer";
import { FAKE_ADDRESS, FakeChain } from "@/testing/fake-chain";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb("fake");
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.sql`truncate ev_logs, ev_cursors`;
});

const ping = parseAbiItem("event Ping(uint256 indexed n)") as AbiEvent;
const stream = (name = "31337:ping", fromBlock = 0n): Stream => ({ name, chain: "local", address: FAKE_ADDRESS, events: [ping], fromBlock });
const count = async () => (await t.sql`select count(*)::int as n from ev_logs`)[0]!.n as number;
const make = (chain: FakeChain, streams = [stream()], extra = {}) =>
  new Indexer({ client: chain.client(), db: t.db, chainId: 31337, streams, confirmations: 0n, sleep: async () => {}, ...extra });

describe("indexer (fake transport)", () => {
  test("chunk-halving: RPC rejects ranges > 100 blocks, indexer still completes", async () => {
    const chain = new FakeChain({ head: 3_000, maxRange: 100 });
    const ix = make(chain);
    const [r] = await ix.runOnce();
    expect(r!.toBlock).toBe(3_000n);
    expect(await count()).toBe(chain.expectedLogs(3_000));
    expect(ix.sizers.get("31337:ping")!.current).toBeLessThanOrEqual(100);
    // Every successful range respected the limit; errors happened and were absorbed.
    const ranges = chain.calls.filter((c) => c.method === "eth_getLogs").map((c) => Number(BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock)) + 1);
    expect(ranges.some((n) => n > 100)).toBe(true);
    const cur = (await t.sql`select last_block, last_block_hash from ev_cursors`)[0]!;
    expect(BigInt(cur.last_block)).toBe(3_000n);
    expect(cur.last_block_hash).toBe(chain.hash(3_000));
  });

  test("gives up after repeated range errors at the minimum chunk", async () => {
    const chain = new FakeChain({ head: 500, maxRange: 10 }); // below the 50-block minimum
    await expect(make(chain).runOnce()).rejects.toThrow();
  });

  test("429 backs off on the same range (no halving) and then succeeds", async () => {
    const chain = new FakeChain({ head: 1_000 });
    chain.rateLimitNext = 3;
    const naps: number[] = [];
    const ix = make(chain, [stream()], { sleep: async (ms: number) => void naps.push(ms) });
    await ix.runOnce();
    expect(naps.length).toBe(3);
    expect(ix.sizers.get("31337:ping")!.current).toBe(5_000);
    expect(await count()).toBe(chain.expectedLogs(1_000));
  });

  test("idempotent: two passes (and a fresh cursor replay) give the same row count", async () => {
    const chain = new FakeChain({ head: 2_000 });
    await make(chain).runOnce();
    const n = await count();
    await make(chain).runOnce();
    expect(await count()).toBe(n);
    await t.sql`delete from ev_cursors`; // replay everything: ON CONFLICT DO NOTHING keeps it exact
    await make(chain).runOnce();
    expect(await count()).toBe(n);
  });

  test("confirmations: stops at head - confirmations", async () => {
    const chain = new FakeChain({ head: 1_000 });
    const [r] = await make(chain, [stream()], { confirmations: 12n }).runOnce();
    expect(r!.toBlock).toBe(988n);
  });

  test("fromBlock: cursor starts at fromBlock - 1, nothing before it is stored", async () => {
    const chain = new FakeChain({ head: 1_000 });
    await make(chain, [stream("31337:late", 500n)]).runOnce();
    const min = (await t.sql`select min(block_number)::int as m from ev_logs`)[0]!.m;
    expect(min).toBeGreaterThanOrEqual(500);
  });

  test("reorg: changed hash at the cursor rewinds 64 blocks, orphaned rows are deleted and replaced", async () => {
    const chain = new FakeChain({ head: 1_000, logEvery: 5 });
    await make(chain).runOnce();
    const oldTx = (await t.sql`select tx_hash from ev_logs where block_number = 990`)[0]!.tx_hash;

    chain.reorgFrom(980, "b"); // blocks 980..1000 replaced
    chain.head = 1_010;
    const [r] = await make(chain).runOnce();
    expect(r!.reorgs).toBe(1);

    const orphan = await t.sql`select 1 from ev_logs where tx_hash = ${oldTx}`;
    expect(orphan.length).toBe(0);
    const bad = await t.sql`select count(*)::int as n from ev_logs where block_number >= 980 and block_hash not in ${t.sql(
      Array.from({ length: 31 }, (_, i) => chain.hash(980 + i)),
    )}`;
    expect(bad[0]!.n).toBe(0);
    expect(await count()).toBe(chain.expectedLogs(1_010));
    expect(REORG_REWIND).toBe(64n);
  });

  test("reorg rewind is chain-wide: other streams' cursors are pulled back too", async () => {
    const chain = new FakeChain({ head: 1_000 });
    const a = stream("31337:a");
    const b = stream("31337:b");
    await make(chain, [a, b]).runOnce();
    await make(chain, [a, b]).rewind(900n);
    const cur = await t.sql`select stream, last_block, last_block_hash from ev_cursors order by stream`;
    expect(cur.map((c) => BigInt(c.last_block))).toEqual([900n, 900n]);
    expect(cur[0]!.last_block_hash).toBe(chain.hash(900));
    expect((await t.sql`select count(*)::int as n from ev_logs where block_number > 900`)[0]!.n).toBe(0);
  });

  test("reorg where the stored block no longer exists (chain got shorter) still rewinds", async () => {
    const chain = new FakeChain({ head: 1_000 });
    await make(chain).runOnce();
    chain.reorgFrom(950, "c");
    chain.head = 960;
    const [r] = await make(chain).runOnce();
    expect(r!.reorgs).toBe(1);
    expect((await t.sql`select max(block_number)::int as m from ev_logs`)[0]!.m).toBeLessThanOrEqual(960);
    expect(await count()).toBe(chain.expectedLogs(960));
  });

  test("/health reports per-stream lag in blocks", async () => {
    const chain = new FakeChain({ head: 1_000 });
    const ix = make(chain, [stream("31337:a")]);
    await ix.runOnce();
    chain.head = 1_042;
    const app = healthApp({ db: t.db, chainId: 31337, streams: [stream("31337:a"), stream("31337:new", 1_000n)], safeHead: () => ix.safeHead() });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.head).toBe("1042");
    expect(body.streams).toEqual([
      { stream: "31337:a", lastBlock: "1000", lag: 42 },
      { stream: "31337:new", lastBlock: "999", lag: 43 },
    ]);
    expect(body.maxLag).toBe(43);
  });

  test("/health is 503 when the RPC is down", async () => {
    const app = healthApp({ db: t.db, chainId: 31337, streams: [], safeHead: async () => { throw new Error("rpc down"); } });
    expect((await app.request("/health")).status).toBe(503);
  });
});
