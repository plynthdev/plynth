// End to end against a real node: anvil + a tiny emitter contract + the CLI's --once mode.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "@plynth/db/src/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, createPublicClient, createWalletClient, http, keccak256, numberToHex, pad, toHex, type Address, type Hex } from "viem";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PORT = 18_545 + Math.floor(Math.random() * 1_000);
const RPC = `http://127.0.0.1:${PORT}`;

// Emitter runtime: LOG2(topic0 = Ping(uint256), topic1 = calldata word 0), no data. 42 bytes.
const PING = keccak256(toHex("Ping(uint256)"));
const RUNTIME = concat(["0x600035", "0x7f", PING, "0x60006000a200"]);
const INIT = concat(["0x602a80600b6000396000f3", RUNTIME]);

let anvil: ReturnType<typeof Bun.spawn>;
let t: Awaited<ReturnType<typeof createTestDb>>;
let emitter: Address;
let from: Address;
let deployBlock: bigint;
let dir: string;
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as any, params: params as any });

async function emit(n: number) {
  const hash = await wallet.sendTransaction({ account: from, to: emitter, data: pad(numberToHex(n)), chain: null });
  await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
}

function runOnce() {
  const r = Bun.spawnSync(["bun", "apps/indexer/src/main.ts", "--once"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: t.url,
      INDEXER_CHAIN: "local",
      LOCAL_RPC_URL: RPC,
      INDEXER_DEPLOYMENTS_DIR: dir,
      INDEXER_STREAMS_FILE: join(dir, "streams.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`indexer --once failed:\n${out}`);
  return out;
}

const pings = async () => (await t.sql`select (data_json->'args'->>'n')::int as n, tx_hash from ev_logs where topic0 = ${PING.toLowerCase()} order by block_number`).map((r) => r.n as number);

beforeAll(async () => {
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  t = await createTestDb("anvil");
  [from] = (await rpc("eth_accounts")) as Address[];
  const hash = await wallet.sendTransaction({ account: from!, data: INIT, chain: null });
  const rcpt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  emitter = rcpt.contractAddress!;
  deployBlock = rcpt.blockNumber;
  expect(await pub.getCode({ address: emitter })).toBe(RUNTIME);
  dir = mkdtempSync(join(tmpdir(), "plynth-ix-"));
  writeFileSync(join(dir, "streams.json"), JSON.stringify([{ name: "emitter", address: emitter, events: ["event Ping(uint256 indexed n)"], fromBlock: Number(deployBlock) }]));
}, 30_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await t?.drop();
});

describe("indexer on anvil", () => {
  let snap: Hex;

  test("emit 3 events, run --once, the 3 rows are in ev_logs with decoded args", async () => {
    snap = (await rpc("evm_snapshot")) as Hex;
    for (const n of [1, 2, 3]) await emit(n);
    const out = runOnce();
    expect(out).toContain("31337:emitter");
    expect(await pings()).toEqual([1, 2, 3]);
    const row = (await t.sql`select address, chain_id from ev_logs limit 1`)[0]!;
    expect(row.address).toBe(emitter.toLowerCase());
    expect(row.chain_id).toBe(31337);
  }, 30_000);

  test("idempotency: --once twice gives the same row count", async () => {
    runOnce();
    expect(await pings()).toEqual([1, 2, 3]);
  }, 30_000);

  test("reorg: anvil_revert + different blocks at the same heights -> orphaned rows removed", async () => {
    const before = await t.sql`select tx_hash from ev_logs`;
    expect(await rpc("evm_revert", [snap])).toBe(true);
    for (const n of [7, 8, 9, 10, 11]) await emit(n); // same heights replaced, chain also grows
    runOnce();
    expect(await pings()).toEqual([7, 8, 9, 10, 11]);
    const orphans = await t.sql`select 1 from ev_logs where tx_hash in ${t.sql(before.map((r) => r.tx_hash))}`;
    expect(orphans.length).toBe(0);
    const cur = (await t.sql`select last_block, last_block_hash from ev_cursors`)[0]!;
    const head = await pub.getBlock();
    expect(BigInt(cur.last_block)).toBe(head.number);
    expect(cur.last_block_hash).toBe(head.hash);
  }, 30_000);
});
