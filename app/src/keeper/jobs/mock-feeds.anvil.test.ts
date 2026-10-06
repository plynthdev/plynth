// refresh-mock-feeds against a real TestnetKit deployment on anvil (chain id 46630, the real Uniswap v4
// PoolManager runtime from 4663 etched at its canonical address, forge script --broadcast). The mainnet reader is
// a fake: no network. Covers: stale kit -> MarketOnHold; one pass -> every feed tracks its real stock (per share),
// the market trades again and each pool sits at the new oracle price (buy AND sell pass); fresh feeds are left
// alone; off-hours keep-alive on and off; a failed mainnet read; a feed the keeper does not own; non-mock files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperDeployment, mockFeedDeployment, type Ctx } from "@/keeper/context";
import { Sender } from "@/keeper/sender";
import { spawnAnvil, type Anvil } from "@/testing/anvil";
import { ANVIL_KEY_0, ANVIL_KEY_1, ROOT } from "@/testing/keeper-helpers";
import { divergenceBps, mockAnswerFor, mockFeedAbi, priceAt, poolStateSlot, runRefreshMockFeeds, type MainnetFeedReader, type MockFeedOptions, type RealFeed } from "./mock-feeds";

const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const E18 = 10n ** 18n;
const KIT_FILE = `kit-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`;
const KIT_PATH = join(ROOT, "app", "deployments", KIT_FILE);

const valuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote q)",
]);
const routerAbi = parseAbi([
  "function buy(address stockToken, uint256 usdgIn, uint16 maxSlippageBps, address recipient) returns (uint256)",
  "function sell(address stockToken, uint256 rawIn, uint16 maxSlippageBps, address recipient) returns (uint256)",
  "error MarketOnHold(address stockToken)",
  "error Slippage(uint256 minOut, uint256 got)",
]);
const tokenAbi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)"]);
const pmAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

/** Real mainnet per-TOKEN answers and multipliers (chain-facts.md, 2026-10-02 closes). */
const REAL: Record<string, { answer: bigint; multiplier: bigint }> = {
  TSLA: { answer: 370_44800000n, multiplier: E18 },
  AAPL: { answer: 333_82400000n, multiplier: 1_000566000000000000n },
  SPY: { answer: 770_71200000n, multiplier: 1_001718000000000000n },
};

let anvil: Anvil | undefined;
let pub: PublicClient;
let dep: Record<string, any>;
let ready = false;
const deployer = privateKeyToAccount(ANVIL_KEY_0);
const other = privateKeyToAccount(ANVIL_KEY_1);

/** Fake mainnet: answers above, updated `realAge` seconds before mainnet "now"; `fail` makes every read throw. */
const fake = { realAge: 60n, fail: false, reads: 0 };
const reader: MainnetFeedReader = {
  async read(symbol) {
    fake.reads++;
    if (fake.fail) throw new Error("HTTP 429 Too Many Requests");
    const r = REAL[symbol];
    if (!r) throw new Error(`no feed ${symbol}`);
    return { answer: r.answer, decimals: 8, updatedAt: 1_800_000_000n - fake.realAge, multiplier: r.multiplier, mainnetNow: 1_800_000_000n } satisfies RealFeed;
  },
};

function ctxFor(key: Hex, deployment = dep, opts: Partial<MockFeedOptions> = {}): Ctx & { logs: string[] } {
  const account = privateKeyToAccount(key);
  const chain = defineChain({ id: 46630, name: "anvil-46630", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil!.rpc] } } });
  const wallet = createWalletClient({ chain, account, transport: http(anvil!.rpc) });
  const sender = new Sender(
    {
      estimateGas: (a) => pub.estimateGas(a),
      estimateFeesPerGas: () => pub.estimateFeesPerGas(),
      getTransactionCount: (a) => pub.getTransactionCount(a),
      sendTransaction: (tx) => wallet.sendTransaction({ ...tx, account, chain }),
      waitForTransactionReceipt: (a) => pub.waitForTransactionReceipt(a),
    },
    account.address,
  );
  const logs: string[] = [];
  return {
    chainId: 46630,
    db: undefined as never, // the job never touches the database
    pub,
    account: account.address,
    sender,
    sealer: undefined as never,
    dep: { mock: mockFeedDeployment(deployment as never) } as Ctx["dep"],
    lookahead: 2,
    mockFeeds: { reader, intervalS: 600, keepAlive: true, realStaleS: 86_400, alignBps: 50, ...opts },
    log: (m) => logs.push(m),
    logs,
  };
}

const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
async function warp(seconds: bigint) {
  await pub.request({ method: "evm_increaseTime" as never, params: [Number(seconds)] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
}
const stock = (sym: string) => dep.stocks[sym] as { token: Address; feed: Address; poolId: Hex; currency0: Address };
const quote = (token: Address) => pub.readContract({ address: dep.valuer, abi: valuerAbi, functionName: "quote", args: [token] });
const feedRound = (feed: Address) => pub.readContract({ address: feed, abi: mockFeedAbi, functionName: "latestRoundData" });

async function simulateTrade(fn: "buy" | "sell", token: Address, amount: bigint) {
  try {
    await pub.simulateContract({ account: deployer.address, address: dep.stockRouter, abi: routerAbi, functionName: fn, args: [token, amount, 100, deployer.address] });
    return "ok";
  } catch (e) {
    const m = String((e as Error).message);
    return m.includes("MarketOnHold") ? "MarketOnHold" : m.includes("Slippage") ? "Slippage" : m.split("\n")[0]!;
  }
}

async function poolDivergence(sym: string): Promise<bigint> {
  const s = stock(sym);
  const slot0 = await pub.readContract({ address: PM, abi: pmAbi, functionName: "extsload", args: [poolStateSlot(s.poolId)] });
  const usdgIs0 = s.currency0.toLowerCase() === String(dep.usdg).toLowerCase();
  const p = priceAt(BigInt(slot0) & ((1n << 160n) - 1n), 6, 18, usdgIs0);
  return divergenceBps(p, (await quote(s.token)).priceUsdPerToken);
}

beforeAll(async () => {
  const fixture = join(ROOT, "contracts", "test", "consumer", "fixtures", "v4_pool_manager.runtime.hex");
  if (!Bun.which("anvil") || !Bun.which("forge") || !existsSync(fixture)) return;
  anvil = await spawnAnvil(["--chain-id", "46630"]);
  pub = createPublicClient({ transport: http(anvil.rpc), pollingInterval: 50 }) as PublicClient;
  await pub.request({ method: "anvil_setCode" as never, params: [PM, `0x${readFileSync(fixture, "utf8").trim()}`] as never });
  const f = Bun.spawnSync(["forge", "script", "script/TestnetKit.s.sol:TestnetKit", "--rpc-url", anvil.rpc, "--broadcast", "--private-key", ANVIL_KEY_0, "--slow"], {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, TESTNET_KIT_FILE: KIT_FILE },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (f.exitCode !== 0) throw new Error(`TestnetKit failed:\n${f.stdout.toString()}${f.stderr.toString()}`);
  dep = JSON.parse(readFileSync(KIT_PATH, "utf8"));
  // Fund the user-side trades the test simulates (deployer owns the kit's mocks).
  const w = createWalletClient({ account: deployer, transport: http(anvil.rpc) });
  for (const [addr, amt] of [[dep.usdg, 1_000_000n * 10n ** 6n], [stock("mTSLA").token, 100n * E18], [stock("mSPY").token, 100n * E18]] as const) {
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: addr, abi: tokenAbi, functionName: "mint", args: [deployer.address, amt], chain: null }) });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: addr, abi: tokenAbi, functionName: "approve", args: [dep.stockRouter, 2n ** 255n], chain: null }) });
  }
  ready = true;
}, 240_000);

afterAll(async () => {
  rmSync(KIT_PATH, { force: true });
  await anvil?.stop();
});

describe("refresh-mock-feeds on a TestnetKit deployment", () => {
  test("the kit writes mockFeeds: true, and the keeper reads it (with the kit's pools and underlyings)", () => {
    if (!ready) return;
    expect(dep.mockFeeds).toBe(true);
    const m = mockFeedDeployment(dep as never);
    expect(m.flag).toBe(true);
    expect(m.stocks.map((s) => s.underlying).sort()).toEqual(["AAPL", "SPY", "TSLA"]);
    expect(m.stocks.every((s) => s.poolId && s.fee === 3000)).toBe(true);
  });

  test("30 min without a refresh: the market holds; one pass tracks the real feeds and trading works again", async () => {
    if (!ready) return;
    await warp(31n * 60n);
    expect((await quote(stock("mTSLA").token)).hold).toBe(true);
    expect(await simulateTrade("buy", stock("mTSLA").token, 100n * 10n ** 6n)).toBe("MarketOnHold");

    const t0 = await now();
    const ctx = ctxFor(ANVIL_KEY_0);
    const r = await runRefreshMockFeeds(ctx);
    expect(r.ok).toBe(true);
    // Three feed posts, and every pool moved (the kit seeded TSLA at $250, AAPL $230, SPY $570).
    expect(r.notes.filter((n) => n.includes("pool aligned"))).toHaveLength(3);
    expect(r.actions).toBe(6);
    for (const [sym, u] of [["mTSLA", "TSLA"], ["mAAPL", "AAPL"], ["mSPY", "SPY"]] as const) {
      const [, answer, , updatedAt] = await feedRound(stock(sym).feed);
      expect(answer).toBe(mockAnswerFor({ ...REAL[u]!, decimals: 8 }, 8, true)); // per share
      expect(updatedAt >= t0).toBe(true); // stamped by the pass, with block time
      const q = await quote(stock(sym).token);
      expect(q.hold).toBe(false);
      // Token price = share x the MOCK token's multiplier (the kit's 1.0 / 1.0005 / 1.0017).
      expect(q.priceUsdPerToken).toBe((answer * 10n ** 10n * q.multiplier) / E18);
      expect(await poolDivergence(sym)).toBeLessThanOrEqual(50n);
    }
    // Buys and sells both pass the router's oracle check (1% max slippage) again; a ~$100 trade is 0.3% fee plus
    // ~0.2% impact on the kit's ~$50k-a-side pools. Before the alignment the pool was ~30% away: one side failed.
    expect(await simulateTrade("buy", stock("mTSLA").token, 100n * 10n ** 6n)).toBe("ok");
    expect(await simulateTrade("sell", stock("mTSLA").token, E18 / 4n)).toBe("ok");
    expect(await simulateTrade("buy", stock("mSPY").token, 100n * 10n ** 6n)).toBe("ok");
    expect(await simulateTrade("sell", stock("mSPY").token, E18 / 8n)).toBe("ok");
  }, 120_000);

  test("feeds younger than the interval are left alone: no mainnet read, no transaction", async () => {
    if (!ready) return;
    const reads = fake.reads;
    const [, , , before] = await feedRound(stock("mTSLA").feed);
    const r = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0));
    expect(r).toMatchObject({ ok: true, actions: 0, notes: [] });
    expect(fake.reads).toBe(reads);
    expect((await feedRound(stock("mTSLA").feed))[3]).toBe(before);
  }, 60_000);

  test("off-hours (real feed a day+ old) with keep-alive: its last answer is re-stamped and logged as a keep-alive", async () => {
    if (!ready) return;
    fake.realAge = 2n * 86_400n;
    try {
      await warp(11n * 60n);
      const [, ansBefore] = await feedRound(stock("mAAPL").feed);
      const t0 = await now();
      const ctx = ctxFor(ANVIL_KEY_0);
      const r = await runRefreshMockFeeds(ctx);
      expect(r.actions).toBe(3); // three re-stamps; pools already at these prices
      expect(r.notes.filter((n) => n.includes("keep-alive"))).toHaveLength(3);
      expect(ctx.logs.some((l) => l.includes("keep-alive"))).toBe(true);
      const [, ansAfter, , ts] = await feedRound(stock("mAAPL").feed);
      expect(ansAfter).toBe(ansBefore);
      expect(ts >= t0).toBe(true);
    } finally {
      fake.realAge = 60n;
    }
  }, 60_000);

  test("off-hours with keep-alive off: nothing is posted and the market holds again after 30 min, like mainnet", async () => {
    if (!ready) return;
    fake.realAge = 2n * 86_400n;
    try {
      await warp(31n * 60n);
      const r = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0, dep, { keepAlive: false }));
      expect(r.actions).toBe(0);
      expect(r.notes).toHaveLength(3);
      expect(r.notes.every((n) => n.includes("KEEPER_MOCK_FEED_KEEP_ALIVE=0"))).toBe(true);
      expect((await quote(stock("mTSLA").token)).hold).toBe(true);
    } finally {
      fake.realAge = 60n;
    }
  }, 60_000);

  test("mainnet read fails: keep-alive re-stamps the mock's own last answer", async () => {
    if (!ready) return;
    fake.fail = true;
    try {
      const [, ansBefore] = await feedRound(stock("mSPY").feed);
      const r = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0));
      expect(r.ok).toBe(true);
      expect(r.actions).toBe(3);
      expect(r.notes.every((n) => n.includes("mainnet read failed"))).toBe(true);
      expect((await feedRound(stock("mSPY").feed))[1]).toBe(ansBefore);
      expect((await quote(stock("mSPY").token)).hold).toBe(false);
    } finally {
      fake.fail = false;
    }
  }, 60_000);

  test("a keeper that does not own the feeds skips them with a note and sends nothing", async () => {
    if (!ready) return;
    await warp(31n * 60n);
    const reads = fake.reads;
    const r = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_1));
    expect(r.actions).toBe(0);
    expect(r.notes).toHaveLength(3);
    expect(r.notes[0]).toContain("not the keeper");
    expect(fake.reads).toBe(reads);
    expect(other.address).not.toBe(deployer.address);
  }, 60_000);

  test("non-mock deployments: a no-op (mockFeeds: false; no flag off testnet; no stocks)", async () => {
    if (!ready) return;
    const reads = fake.reads;
    for (const d of [{ ...dep, mockFeeds: false }, { ...dep, mockFeeds: undefined, chainId: 31337 }, { chainId: 46630, mockFeeds: true }]) {
      const ctx = ctxFor(ANVIL_KEY_0, d);
      if (d.chainId === 31337) ctx.chainId = 31337;
      expect(await runRefreshMockFeeds(ctx)).toEqual({ job: "refresh-mock-feeds", ok: true, actions: 0, notes: [] });
    }
    // And with no options at all (a keeper built without them).
    const bare = ctxFor(ANVIL_KEY_0);
    delete bare.mockFeeds;
    expect((await runRefreshMockFeeds(bare)).actions).toBe(0);
    expect(fake.reads).toBe(reads);
  }, 60_000);

  test("a kit file from before the flag is recognised on 46630 by its mock feed descriptions", async () => {
    if (!ready) return;
    const { mockFeeds: _drop, ...old } = dep;
    const r = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0, old));
    expect(r.ok).toBe(true);
    expect(r.actions).toBe(3); // 31 min passed in the previous tests: all three tracked again
  }, 60_000);

  test("a move with alignment off leaves the pool behind (sells fail Slippage); the next pass realigns it", async () => {
    if (!ready) return;
    const was = REAL.TSLA!.answer;
    REAL.TSLA!.answer = (was * 110n) / 100n; // TSLA +10% on mainnet
    try {
      await warp(11n * 60n);
      const r1 = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0, dep, { alignBps: 0 }));
      expect(r1.notes.some((n) => n.startsWith("mTSLA:") && n.includes("from TSLA"))).toBe(true);
      expect(await poolDivergence("mTSLA")).toBeGreaterThan(800n);
      // Oracle above the pool: a buy gets more than the oracle minimum, a sell gets less.
      expect(await simulateTrade("buy", stock("mTSLA").token, 100n * 10n ** 6n)).toBe("ok");
      expect(await simulateTrade("sell", stock("mTSLA").token, E18 / 4n)).toBe("Slippage");

      const r2 = await runRefreshMockFeeds(ctxFor(ANVIL_KEY_0)); // feeds fresh now: alignment only
      expect(r2.actions).toBe(1);
      expect(r2.notes).toHaveLength(1);
      expect(r2.notes[0]).toMatch(/^mTSLA: pool aligned \d+ -> 0 bps \(buy \d+\)$/);
      expect(await poolDivergence("mTSLA")).toBeLessThanOrEqual(1n);
      expect(await simulateTrade("sell", stock("mTSLA").token, E18 / 4n)).toBe("ok");
    } finally {
      REAL.TSLA!.answer = was;
    }
  }, 60_000);

  test("keeperDeployment keeps reading full consumer files and exposes the mock slice", () => {
    if (!ready) return;
    const full = { ...dep, savingsVault: dep.usdg, crowdBuy: dep.usdg, jitterBeacon: dep.jitterBeacon };
    const k = keeperDeployment(full as never, 46630);
    expect(k.mock.flag).toBe(true);
    expect(k.mock.stocks).toHaveLength(3);
  });
});
