// The dashboard API against real chain state and real indexer + keeper output (the todo-07 fixture).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readDeployment } from "@/indexer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, parseAbi, type Abi, type Address } from "viem";
import { apiDeployment, BlockTimes, createApp, type ApiDeployment } from "./";
import { ROOT, seedFixture, type Fixture } from "@/testing/api-fixture";

const ORIGIN = "http://localhost:5173";
let fx: Fixture;
let app: ReturnType<typeof createApp>;
let dep: ApiDeployment;

beforeAll(async () => {
  fx = await seedFixture();
  dep = apiDeployment(readDeployment(fx.dir, 31337), 31337);
  app = createApp({ chainId: 31337, pub: fx.pub, db: fx.db.db, dep, blockTimes: new BlockTimes(fx.pub) });
}, 240_000);

afterAll(async () => {
  await fx?.cleanup();
});

/**
 * Replaces every leaf with its type, so snapshots pin the JSON shape, not run-specific values. Array
 * elements are merged (keys unioned, differing leaf types joined with "|"), so every row variant counts.
 */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [v.map(shape).reduce(merge)] : [];
  if (v === null) return "null";
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}
function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [merge(a[0], b[0])] : a.length ? a : b;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const x = (a as any)[k];
      const y = (b as any)[k];
      out[k] = x === undefined ? `${String(y)}|missing` : y === undefined ? `${String(x)}|missing` : merge(x, y);
    }
    return out;
  }
  if (typeof a === "string" && typeof b === "string") return [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  return a;
}

async function trpcGet(path: string, input?: unknown, headers: Record<string, string> = {}) {
  const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const r = await app.request(`/trpc/${path}${qs}`, { headers });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).result.data;
}
async function trpcPost(path: string, input: unknown) {
  const r = await app.request(`/trpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).result.data;
}
async function rest(path: string, init?: RequestInit) {
  const r = await app.request(path, init);
  return { status: r.status, body: (await r.json()) as any };
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("account.overview", () => {
  test("values holdings with Valuer math, splits USDG, reports week round-ups and mode; REST mirror identical", async () => {
    const u0 = fx.users[0]!;
    const data = await trpcGet("account.overview", { address: u0 });
    expect(shape(data)).toMatchSnapshot();
    expect((await rest(`/v1/account/${u0}/overview`)).body).toEqual(data);

    // user0: claimed its mTSLA allocation (now in the wallet), mNVDA half of 1.20 still queued (crowd of 1).
    expect(data.mode).toBe("open");
    expect(data.weeklyCap).toBe("500.000000");
    expect(data.allocation.parkUsd).toBe("0.000000");
    expect(data.allocation.queuedUsdg).toBe("0.600000");
    // 300 deposit - 1.20 round-up (moved to pending, then swept) + 25 top-up = 323.80 in the vault
    expect(data.allocation.vaultUsdg).toBe("323.800000");
    expect(data.allocation.availableUsdg).toBe("324.400000");
    const h = data.holdings.find((x: any) => x.symbol === "mTSLA");
    expect(h.hold).toBe(false);
    expect(BigInt(h.walletRaw)).toBeGreaterThan(0n);
    expect(h.claimableRaw).toBe("0");
    // Valuer: raw x multiplier x price; the local mock is 250 USD per token, 18 decimals, multiplier 1.
    const valued = (await fx.pub.readContract({ address: dep.valuer, abi: parseAbi(["function value(address,uint256) view returns (uint256,bool)"]), functionName: "value", args: [fx.tsla, BigInt(h.raw)] })) as [bigint, boolean];
    expect(h.usd).toBe((Number(valued[0] / 10n ** 12n) / 1e6).toFixed(6));
    expect(h.multiplier).toBe("1.000000");
    const total = Number(data.allocation.stockTokensUsd) + Number(data.allocation.parkUsd) + Number(data.allocation.availableUsdg);
    expect(Math.abs(Number(data.totalHoldingsUsd) - total)).toBeLessThan(0.000002);
  }, 60_000);

  test("an unclaimed executed allocation counts as a holding (claimableRaw) for user1", async () => {
    const data = await trpcGet("account.overview", { address: fx.users[1]! });
    const h = data.holdings.find((x: any) => x.symbol === "mTSLA");
    expect(h.walletRaw).toBe("0");
    expect(BigInt(h.claimableRaw)).toBeGreaterThan(0n);
    expect(data.allocation.queuedUsdg).toBe("0.000000");
  }, 30_000);

  test("hold is flagged when the feed goes stale", async () => {
    // Make the Valuer see a stale feed: warp past maxStaleness is 3650 days in the local kit, so instead
    // point at a fresh snapshot, warp 11 years, read, and revert.
    const snap = await fx.pub.request({ method: "evm_snapshot" as any, params: [] as any });
    await fx.pub.request({ method: "evm_increaseTime" as any, params: [3651 * 86_400] as any });
    await fx.pub.request({ method: "evm_mine" as any, params: [] as any });
    const data = await trpcGet("account.overview", { address: fx.users[0]! });
    expect(data.holdings.every((h: any) => h.hold === true)).toBe(true);
    await fx.pub.request({ method: "evm_revert" as any, params: [snap] as any });
  }, 30_000);

  test("an address with nothing gets zeros, not an error", async () => {
    const data = await trpcGet("account.overview", { address: fx.stranger });
    expect(data.totalHoldingsUsd).toBe("0.000000");
    expect(data.holdings).toEqual([]);
    expect(data.weekRoundups).toBe("0.000000");
  });
});

describe("account.habit", () => {
  test("daily cumulative saved USDG per range; REST mirror identical", async () => {
    for (const range of ["1W", "1M", "3M", "ALL"] as const) {
      const data = await trpcGet("account.habit", { address: fx.users[1]!, range });
      expect((await rest(`/v1/account/${fx.users[1]}/habit?range=${range}`)).body).toEqual(data);
      if (range === "1W") expect(data.points).toHaveLength(7);
      if (range === "1M") expect(data.points).toHaveLength(30);
      if (range === "3M") expect(data.points).toHaveLength(90);
      // user1: 300 deposit + 0.75 round-up - 10 withdrawal
      expect(data.points.at(-1).savedUsdg).toBe("290.750000");
      const vals = data.points.map((p: any) => p.date);
      expect([...vals].sort()).toEqual(vals);
    }
    expect(shape(await trpcGet("account.habit", { address: fx.users[1]!, range: "1W" }))).toMatchSnapshot();
  }, 60_000);
});

describe("account.activity", () => {
  test("rows use the site wording and paginate by cursor; REST mirror identical", async () => {
    const u0 = fx.users[0]!;
    const all = await trpcGet("account.activity", { address: u0, limit: 100 });
    expect(shape(all)).toMatchSnapshot();
    expect((await rest(`/v1/account/${u0}/activity?limit=100`)).body).toEqual(all);
    const by = (k: string) => all.rows.filter((r: any) => r.kind === k);
    expect(by("roundup").map((r: any) => [r.label, r.amount, r.status])).toEqual([["Round-up", "1.200000", "Saved"]]);
    expect(by("topup").map((r: any) => [r.label, r.amount, r.status])).toEqual([["Fixed top-up", "25.000000", "Added"]]);
    const crowd = by("crowd_allocation").map((r: any) => [r.label, r.detail, r.amount, r.status]);
    expect(crowd).toContainEqual(["Crowd Buy allocation", "mTSLA", "0.600000", "Delivered"]);
    expect(crowd).toContainEqual(["Crowd Buy allocation", "mNVDA", "0.600000", "Queued"]);
    expect(by("delivery")).toHaveLength(1);
    expect(by("delivery")[0].status).toBe("Delivered");
    expect(by("delivery")[0].unit).toBe("mTSLA");
    const ats = all.rows.map((r: any) => r.at);
    expect([...ats].sort().reverse()).toEqual(ats);

    // Paging two at a time walks the same rows in the same order.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await trpcGet("account.activity", cursor ? { address: u0, limit: 2, cursor } : { address: u0, limit: 2 });
      seen.push(...page.rows.map((r: any) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.rows.map((r: any) => r.id));
  }, 60_000);

  test("user1's executed-but-unclaimed allocation reads Ready; zero round-ups are hidden for user2", async () => {
    const a1 = await trpcGet("account.activity", { address: fx.users[1]! });
    expect(a1.rows.find((r: any) => r.kind === "crowd_allocation").status).toBe("Ready");
    const a2 = await trpcGet("account.activity", { address: fx.users[2]! });
    expect(a2.rows.filter((r: any) => r.kind === "roundup").map((r: any) => r.amount)).toEqual(["0.990000"]);
  }, 30_000);
});

describe("account.settings + crowd.books + meta", () => {
  test("settings mirror the vault; REST identical", async () => {
    const s = await trpcGet("account.settings", { address: fx.users[0]! });
    expect(shape(s)).toMatchSnapshot();
    expect((await rest(`/v1/account/${fx.users[0]}/settings`)).body).toEqual(s);
    expect(s).toMatchObject({ configured: true, roundTo: 1, multiplier: 2, weeklyCap: "500.000000", fixedTopUp: "25.000000", mode: "open" });
    expect(s.mix.map((m: any) => [m.symbol, m.weightBps])).toEqual([["mTSLA", 5000], ["mNVDA", 5000]]);
  });

  test("crowd.books: open book vs MIN_CROWD, next window, revealed executeAfter, executed history; REST identical", async () => {
    const all = await trpcGet("crowd.books", {});
    expect(shape(all)).toMatchSnapshot();
    expect((await rest("/v1/crowd/books")).body).toEqual(all);
    const t = all.books.find((b: any) => b.symbol === "mTSLA");
    expect(t.open.minCrowd).toBe(3);
    expect(t.open.bookId).toBe("1");
    expect(t.open.executedThisWindow).toBe(true);
    expect(t.open.executeAfter).not.toBeNull(); // this window was revealed
    expect(t.executed).toHaveLength(1);
    expect(t.executed[0]).toMatchObject({ bookId: "0", accounts: 3 });
    const n = all.books.find((b: any) => b.symbol === "mNVDA");
    expect(n.open).toMatchObject({ bookId: "0", accounts: 1, usdgTotal: "0.600000", executedThisWindow: false });
    expect(Date.parse(all.window.next)).toBeGreaterThan(Date.parse(all.now));

    const one = await trpcGet("crowd.books", { asset: fx.nvda });
    expect(one.books).toHaveLength(1);
    expect((await rest(`/v1/crowd/books?asset=${fx.nvda}`)).body).toEqual(one);
    expect((await rest(`/v1/crowd/books?asset=${fx.stranger}`)).status).toBe(404);
  }, 30_000);

  test("meta.health reports chain head and indexer lag; REST identical", async () => {
    const h = await trpcGet("meta.health");
    expect(shape(h)).toMatchSnapshot();
    expect(h.ok).toBe(true);
    expect(h.db).toBe(true);
    const r = await rest("/v1/meta/health");
    expect(r.status).toBe(200);
    expect({ ...r.body, head: h.head, indexer: h.indexer }).toEqual(h);
  });

  test("meta.eligibility shape; REST identical", async () => {
    const hdr = { "x-plynth-residency": "DE" };
    const e = await trpcGet("meta.eligibility", undefined, hdr);
    expect(shape(e)).toMatchSnapshot();
    expect((await rest("/v1/meta/eligibility", { headers: hdr })).body).toEqual(e);
  });
});

/** The compiled contract ABIs (forge build output from the fixture's forge script), not the API's own copy. */
function artifactAbi(name: string): Abi {
  return JSON.parse(readFileSync(join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8")).abi as Abi;
}

describe("tx builders", () => {
  test("every builder decodes against the compiled ABI to the intended call, and REST == tRPC", async () => {
    const vault = artifactAbi("SavingsVault");
    const crowd = artifactAbi("CrowdBuy");
    const cases: [string, unknown, Abi, string, unknown[], Address][] = [
      ["setSettings", { roundTo: 5, multiplier: 3, weeklyCap: "120.5", fixedTopUp: "50", mode: "quiet" }, vault, "setSettings", [{ roundTo: 5, multiplier: 3, weeklyCap: 120_500_000n, fixedTopUp: 50_000_000n, mode: 1 }], dep.vault],
      ["deposit", { amount: "12.34" }, vault, "deposit", [12_340_000n], dep.vault],
      ["withdraw", { amount: "1", to: fx.users[2] }, vault, "withdraw", [1_000_000n, fx.users[2]], dep.vault],
      ["setMix", { mix: [{ token: fx.tsla, weightBps: 7000 }, { token: fx.nvda, weightBps: 3000 }] }, vault, "setMix", [[{ stockToken: fx.tsla, weightBps: 7000 }, { stockToken: fx.nvda, weightBps: 3000 }]], dep.vault],
      ["claimOpen", { asset: fx.tsla, bookId: "0" }, crowd, "claimOpen", [fx.tsla, 0n], dep.crowd],
      ["approveUsdg", { amount: "5" }, parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]), "approve", [dep.vault, 5_000_000n], dep.usdg],
    ];
    for (const [proc, input, abi, fn, args, to] of cases) {
      const t = await trpcPost(`tx.${proc}`, input);
      expect((await rest(`/v1/tx/${proc}`, post(input))).body).toEqual(t);
      expect(t.to).toBe(to);
      expect(t.value).toBe("0");
      expect(t.chainId).toBe(31337);
      const d = decodeFunctionData({ abi, data: t.data });
      expect(d.functionName).toBe(fn);
      expect(JSON.stringify(d.args, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v))).toBe(
        JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v)),
      );
    }
    expect(shape(await trpcPost("tx.deposit", { amount: "1" }))).toMatchSnapshot();
  }, 30_000);

  test("the user's own wallet can sign and send what the builders return (withdraw + setSettings on anvil)", async () => {
    const u2 = fx.users[2]!;
    const w = await trpcPost("tx.withdraw", { amount: "2.5", to: u2 });
    const s = await trpcPost("tx.setSettings", { roundTo: 10, multiplier: 1, weeklyCap: "100", fixedTopUp: "0", mode: "open" });
    for (const t of [w, s]) {
      const hash = await fx.wc.sendTransaction({ account: u2, to: t.to, data: t.data, value: BigInt(t.value), chain: null } as any);
      const r = await fx.pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      expect(r.status).toBe("success");
    }
    const st = await trpcGet("account.settings", { address: u2 });
    expect(st).toMatchObject({ roundTo: 10, multiplier: 1, weeklyCap: "100.000000" });
    fx.indexer();
    const h = await trpcGet("account.habit", { address: u2, range: "1W" });
    // 300 deposit + 0.99 round-up - 2.5 withdrawal
    expect(h.points.at(-1).savedUsdg).toBe("298.490000");
  }, 60_000);
});

describe("CORS on the real app", () => {
  test("allowed origin gets ACAO; unknown origin is refused", async () => {
    const ok = await app.request(`/v1/meta/eligibility`, { headers: { origin: ORIGIN } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const bad = await app.request(`/trpc/account.overview?input=${encodeURIComponent(JSON.stringify({ address: fx.users[0] }))}`, { headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("main.ts", () => {
  test("boots against the fixture chain on a random port and serves REST + tRPC", async () => {
    const proc = Bun.spawn(["bun", "app/src/bin/api.ts"], {
      cwd: ROOT,
      env: { ...process.env, API_CHAIN: "local", LOCAL_RPC_URL: fx.anvil.rpc, DATABASE_URL: fx.db.url, API_DEPLOYMENTS_DIR: fx.dir, API_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      const deadline = Date.now() + 20_000;
      while (!/listening on :(\d+)/.test(out) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const port = /listening on :(\d+)/.exec(out)?.[1];
      expect(port).toBeDefined();
      const r = await fetch(`http://127.0.0.1:${port}/v1/account/${fx.users[0]}/settings`);
      expect(r.status).toBe(200);
      const t = (await (await fetch(`http://127.0.0.1:${port}/trpc/account.settings?input=${encodeURIComponent(JSON.stringify({ address: fx.users[0] }))}`)).json()) as any;
      expect(await r.json()).toEqual(t.result.data);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});
