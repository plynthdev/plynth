// Todo 14 end to end on plain anvil: a treasury built by TreasuryFactory (balanced template, 100k USDG + 40 mTSLA),
// the desks (todo 12) and the close service (todo 13) run once, then every treasury endpoint is read and checked
// against the chain and against each other. Also: treasury.create / policy.propose return transactions that the
// board can send as-is, and the signed webhooks fire for guard.denied, close.committed and drawdown.state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@plynth/db";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventLog, getAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebhookDispatcher, WebhookStore } from "../../treasury/webhooks/dispatcher";
import { KEYS, Kit, ROOT } from "../../treasury/test/kit";
import { BlockTimes, createApp, factoryAbi, type ApiDeployment } from "../src";

const PORT = 9700 + Math.floor(Math.random() * 50);
const RPC = `http://127.0.0.1:${PORT}`;
const FUNDING = 100_000n * 10n ** 6n;
const PERIOD = 30n * 86_400n;
const FEE_TO = getAddress("0x00000000000000000000000000000000000fee14");
const BOARD2 = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key (anvil #3)
const SECRET = "whsec-test-0123456789abcdef"; // test-key (HMAC secret for a local receiver)

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let app: ReturnType<typeof createApp>;
let acct: Address;
let cfgPath: string;
let ready = false;

function run(script: string, args: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", "run", script, ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl, TREASURY_RPC_URL: RPC, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${script} failed:\n${out}`);
  return out;
}

async function trpc(path: string, input: unknown, method: "GET" | "POST" = "GET") {
  const r =
    method === "GET"
      ? await app.request(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await app.request(`/trpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
  const j = (await r.json()) as any;
  return { status: r.status, data: j.result?.data, error: j.error };
}
async function ok(path: string, input: unknown, method: "GET" | "POST" = "GET") {
  const r = await trpc(path, input, method);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data;
}
async function rest(path: string, init?: RequestInit) {
  const r = await app.request(path, init);
  return { status: r.status, body: (await r.json()) as any };
}

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "TreasuryFactory.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "TreasuryFactory.sol"))) return;
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  kit = new Kit(RPC);
  for (let i = 0; i < 100; i++) {
    try {
      await kit.pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  dbUrl = withDatabase(databaseUrl(), `plynth_t_api_treasury_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);

  cfgPath = await kit.setup(mkdtempSync(join(tmpdir(), "plynth-api-treasury-")), FUNDING, { factory: { feeTo: FEE_TO } });
  acct = kit.a.account!;
  const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
  await kit.send(tsla.token, "MockStockToken.sol", "MockStockToken", "mint", [acct, 40n * 10n ** 18n]);

  // Desks (todo 12) once, plus one guard denial as the desks would log it.
  run("treasury:desks", ["--once"], { TREASURY_CONFIG: cfgPath, TREASURY_CASH_DESK_KEY: KEYS.cash, TREASURY_EQUITY_DESK_KEY: KEYS.equity });
  await conn.sql`insert into desk_actions (chain_id, account, desk, action, status, reason_code, reason, asset) values (31337, ${acct.toLowerCase()}, 'equity', 'buy', 'rejected', 4, 'R3_ORDER_CAP', ${tsla.token.toLowerCase()})`;
  await conn.sql`insert into exceptions (chain_id, account, kind, key, venue, detail, status) values (31337, ${acct.toLowerCase()}, 'reconcile.position', 'reconcile.position:v:u', '0x00000000000000000000000000000000000000aa', '{"diff":"1"}', 'resolved')`;

  // Close service (todo 13) once, after the period with fresh feeds.
  const start = await kit.read<bigint>(kit.a.periodClose!, "PeriodClose.sol", "PeriodClose", "startTime");
  await kit.warpTo(start + PERIOD + 60n);
  await kit.refreshFeeds();
  const out = run("treasury:close", ["--once"], { TREASURY_PERIOD_CLOSE: kit.a.periodClose!, TREASURY_CONTROLLER_KEY: KEYS.deployer });
  if (!out.includes('"status":"committed"')) throw new Error(`close did not commit:\n${out}`);

  const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const dep: ApiDeployment = { vault: A(1), crowd: A(2), beacon: A(3), valuer: kit.a.valuer!, usdg: kit.a.usdg!, stocks: [], deployBlock: 0n, treasuryFactory: kit.a.factory!, treasuryFactoryBlock: kit.factoryBlock };
  app = createApp({ chainId: 31337, pub: kit.pub, db: conn.db, dep, blockTimes: new BlockTimes(kit.pub) });
  ready = true;
}, 240_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

describe("treasury API on a factory-made treasury", () => {
  test("nav.latest, positions.list and the bands agree with each other and with the guard snapshot", async () => {
    if (!ready) return;
    const nav = await ok("nav.latest", { account: acct });
    const pos = await ok("positions.list", { account: acct });
    expect(pos.blockNumber).toBe(nav.blockNumber);
    expect(pos.navUsdRaw).toBe(nav.navUsdRaw);
    const sum = pos.positions.reduce((s: bigint, p: any) => s + BigInt(p.usdRaw), 0n);
    expect(sum).toBe(BigInt(nav.navUsdRaw));
    const [chainNav] = await kit.read<[bigint, boolean]>(acct, "TreasuryAccount.sol", "TreasuryAccount", "navUsd");
    expect(BigInt(nav.navUsdRaw)).toBe(chainNav);
    const byBand = (b: string) => pos.positions.filter((p: any) => p.band === b).reduce((s: bigint, p: any) => s + BigInt(p.usdRaw), 0n);
    expect(nav.bands.cash.bps).toBe(Number((byBand("cash") * 10_000n) / chainNav));
    expect(nav.bands.equity.bps).toBe(Number((byBand("equity") * 10_000n) / chainNav));
    const tsla = pos.positions.find((p: any) => p.symbol === "mTSLA");
    expect(tsla.kind).toBe("stock_token");
    expect(BigInt(tsla.raw)).toBeGreaterThanOrEqual(40n * 10n ** 18n);
    // Nothing moved since the close: periodStartNav is the NAV after the fee, drawdown 0.
    expect(nav.periodStartNav).toBe(nav.navUsd);
    expect(nav.drawdownBps).toBe(0);
    expect((await rest(`/v1/treasury/${acct}/nav`)).body).toEqual(nav);
    expect((await rest(`/v1/treasury/${acct}/positions`)).body).toEqual(pos);
  }, 60_000);

  test("close.list, close.get, nav.history and the CFO pack describe the same committed close", async () => {
    if (!ready) return;
    const list = await ok("close.list", { account: acct });
    expect(list.periodClose).toBe(kit.a.periodClose);
    expect(list.closes).toHaveLength(1);
    expect(list.pending).toHaveLength(0);
    const c = list.closes[0];
    expect(c.bundleStored).toBe(true);
    expect(c.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const hist = await ok("nav.history", { account: acct });
    expect(hist.points).toHaveLength(1);
    expect(hist.points[0].navUsdRaw).toBe(c.navUsdRaw);
    expect(hist.points[0].periodEndUnix).toBe(c.periodEndUnix);

    const got = await ok("close.get", { account: acct, index: 0 });
    expect(got.bundleVerified).toBe(true);
    expect(got.close).toEqual({ ...c, txHash: undefined, bundleStored: undefined, ...got.close });
    expect(got.bundle.navUsd).toBe(c.navUsdRaw);
    expect(got.txHash).toBe(c.txHash);
    const feeRaw = await kit.read<bigint>(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "balanceOf", [FEE_TO]);
    expect(feeRaw).toBeGreaterThan(0n);
    expect(got.fee.feePaid).toBe((Number(feeRaw) / 1e6).toFixed(6));
    // NAV now = closed NAV - fee (USDG 6dp -> USD 1e18)
    const nav = await ok("nav.latest", { account: acct });
    expect(BigInt(nav.navUsdRaw)).toBe(BigInt(c.navUsdRaw) - feeRaw * 10n ** 12n);

    // The bundle lists the guard denial logged during the period.
    expect(got.bundle.deskActions.some((a: any) => a.reasonCode === 4 && a.status === "rejected")).toBe(true);

    const json = await ok("cfo.pack", { account: acct, periodEnd: c.periodEndUnix, format: "json" });
    expect(json.contentType).toBe("application/json");
    const statement = JSON.parse(json.body);
    expect(JSON.stringify(statement)).toContain(c.bundleHash);
    const csv = await ok("cfo.pack", { account: acct, periodEnd: c.periodEndUnix, format: "csv" });
    expect(csv.body.split("\n").length).toBeGreaterThan(2);
    const dl = await app.request(`/v1/treasury/${acct}/cfo-pack/${c.periodEndUnix}/download?format=html`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("text/html");
    expect(await dl.text()).toContain("<html");
    // No close at that periodEnd -> refused, not rendered.
    expect((await trpc("cfo.pack", { account: acct, periodEnd: "1", format: "json" })).status).toBe(412);
    expect((await trpc("close.get", { account: acct, index: 5 })).status).toBe(404);
  }, 60_000);

  test("desk.list, actions.list and exceptions.list match the chain and the service tables", async () => {
    if (!ready) return;
    const desks = await ok("desk.list", { account: acct });
    const byName = Object.fromEntries(desks.desks.map((x: any) => [x.name, x]));
    expect(byName.cash.key).toBe(kit.cashKey.address);
    expect(byName.cash.adapters).toEqual([getAddress(kit.a.cashSleeve!)]);
    expect(byName.equity.key).toBe(kit.equityKey.address);
    expect(byName.equity.active).toBe(true);
    expect(byName.cash.deskId).toBe(stringToHex("cash", { size: 32 }));

    const n = Number((await conn.sql`select count(*)::int as n from desk_actions where account = ${acct.toLowerCase()}`)[0]!.n);
    const all = await ok("actions.list", { account: acct, limit: 200 });
    expect(all.actions).toHaveLength(n);
    expect(all.actions.some((a: any) => a.reasonCode === 4 && a.reason === "R3_ORDER_CAP")).toBe(true);
    expect(byName.equity.lastAction.id).toBe(Math.max(...all.actions.filter((a: any) => a.desk === "equity").map((a: any) => a.id)));
    // Cursor pagination walks the same rows.
    const page1 = await ok("actions.list", { account: acct, limit: 1 });
    const page2 = await ok("actions.list", { account: acct, limit: 1, cursor: Number(page1.nextCursor) });
    expect(page2.actions[0].id).toBeLessThan(page1.actions[0].id);
    expect((await rest(`/v1/treasury/${acct}/actions?desk=equity&limit=200`)).body.actions.every((a: any) => a.desk === "equity")).toBe(true);

    const ex = await ok("exceptions.list", { account: acct });
    expect(ex.approvals).toBe(kit.a.approvals);
    expect(ex.reconcile).toHaveLength(1);
    expect((await ok("exceptions.list", { account: acct, status: "open" })).reconcile).toHaveLength(0);
  }, 60_000);

  test("policy.current / diff / propose: the proposal tx is accepted by the policy contract as built", async () => {
    if (!ready) return;
    const cur = await ok("policy.current", { account: acct });
    expect(cur.version).toBe(1);
    expect(cur.tier).toBe("T1");
    expect(cur.board).toBe(kit.deployer.address);
    expect(cur.pending).toBeNull();
    const controller = kit.deployer.address;
    const same = await ok("policy.diff", { account: acct, template: kit.template, controller });
    expect(same.changed).toBe(false);
    expect(same.nextHash).toBe(cur.hash);

    const next = { ...kit.template, limits: { ...(kit.template.limits as object), perOrderUsd: 50_000 } };
    const d = await ok("policy.diff", { account: acct, template: next, controller });
    expect(d.changed).toBe(true);
    expect(d.diff).toContain("Per-order cap");
    const p = await ok("policy.propose", { account: acct, template: next, controller }, "POST");
    expect(p.tx.to).toBe(cur.policyContract);
    const hash = await kit.wallet(kit.deployer).sendTransaction({ to: p.tx.to, data: p.tx.data });
    expect((await kit.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const after = await ok("policy.current", { account: acct });
    expect(after.pending.hash).toBe(p.hash);
    expect(after.version).toBe(1); // timelocked: still the old one in force

    expect((await trpc("policy.propose", { account: acct, template: { ...kit.template, bands: { cash: [80, 20], equity: [0, 100] } }, controller }, "POST")).status).toBe(400);
  }, 60_000);

  test("treasury.create: the board sends the returned tx and gets the predicted, wired treasury", async () => {
    if (!ready) return;
    const t = await ok("treasury.create", { template: kit.template, controller: kit.deployer.address, board: BOARD2.address }, "POST");
    expect(t.tx.to).toBe(kit.a.factory);
    const hash = await kit.wallet(BOARD2).sendTransaction({ to: t.tx.to, data: t.tx.data });
    const r = await kit.pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
    const ev = r.logs.map((l) => {
      try {
        return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics });
      } catch {
        return undefined;
      }
    }).find((e) => e?.eventName === "TreasuryCreated")!;
    const a = ev.args as { account: Address; board: Address; policyHash: Hex };
    expect(a.account).toBe(t.predicted.account);
    expect(a.board).toBe(BOARD2.address);
    expect(a.policyHash).toBe(t.policyHash);
    const cur = await ok("policy.current", { account: a.account });
    expect(cur.hash).toBe(t.policyHash);
    expect(cur.board).toBe(BOARD2.address);
    const nav = await ok("nav.latest", { account: a.account });
    expect(nav.navUsdRaw).toBe("0");
    expect((await ok("close.list", { account: a.account })).closes).toHaveLength(0);
    // The REST mirror and template listing.
    expect((await rest("/v1/treasury/templates")).body.map((x: any) => x.name)).toEqual(["balanced", "carry", "conservative"]);
    const bad = await rest("/v1/treasury/create", { method: "POST", body: JSON.stringify({ templateName: "nope", controller: kit.deployer.address, board: BOARD2.address }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
  }, 60_000);

  test("anything that is not a treasury account is a 404", async () => {
    if (!ready) return;
    for (const p of ["nav.latest", "positions.list", "policy.current", "desk.list", "close.list"]) {
      expect((await trpc(p, { account: kit.a.usdg })).status).toBe(404);
    }
  }, 60_000);
});

describe("signed webhooks", () => {
  test("guard.denied, close.committed and drawdown.state reach the subscriber once, HMAC-signed", async () => {
    if (!ready) return;
    const got: { body: string; sig: string | null }[] = [];
    let failFirst = true;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        if (new URL(req.url).pathname === "/flaky" && failFirst) {
          failFirst = false;
          return new Response("busy", { status: 503 });
        }
        got.push({ body, sig: req.headers.get("x-plinth-signature") });
        return new Response("ok");
      },
    });
    try {
      const store = new WebhookStore(conn.db);
      await store.add(31337, acct, `http://127.0.0.1:${server.port}/hook`, SECRET, ["guard.denied", "close.committed", "drawdown.state"]);
      await expect(store.add(31337, acct, "http://example.com/hook", SECRET, ["guard.denied"])).rejects.toThrow(/https/);
      await expect(store.add(31337, acct, "https://example.com/hook", "short", ["guard.denied"])).rejects.toThrow(/secret/);
      await expect(store.add(31337, acct, "https://example.com/hook", SECRET, ["nope"])).rejects.toThrow(/unknown/);
      expect((await store.list(31337, acct))[0]).not.toHaveProperty("secret");

      const d = new WebhookDispatcher(conn.db, { chainId: 31337, backoffMs: 10 });
      const first = await d.pollOnce();
      expect(first.every((x) => x.ok)).toBe(true);
      const types = got.map((g) => JSON.parse(g.body).type);
      expect(types).toContain("guard.denied");
      expect(types).toContain("close.committed");
      for (const g of got) expect(g.sig).toBe(`sha256=${createHmac("sha256", SECRET).update(g.body).digest("hex")}`);
      const denied = got.map((g) => JSON.parse(g.body)).find((b) => b.type === "guard.denied" && b.data.reasonCode === 4);
      expect(denied.data.account).toBe(acct);
      const closed = got.map((g) => JSON.parse(g.body)).find((b) => b.type === "close.committed");
      const list = await ok("close.list", { account: acct });
      expect(closed.data.bundleHash).toBe(list.closes[0].bundleHash.toLowerCase());
      expect(closed.data.navUsd).toBe(list.closes[0].navUsdRaw);

      // Idempotent: a second poll sends nothing new.
      const n = got.length;
      await d.pollOnce();
      expect(got.length).toBe(n);

      // drawdown.state pushed by the risk service; a flaky receiver gets it after a retry.
      await store.add(31337, acct, `http://127.0.0.1:${server.port}/flaky`, SECRET, ["drawdown.state"]);
      const res = await d.emit({ type: "drawdown.state", data: { account: acct, from: "normal", to: "paused", ddBps: -450, blockNumber: 123n } });
      expect(res).toHaveLength(2);
      expect(res.every((x) => x.ok)).toBe(true);
      expect(res.find((x) => x.attempts === 2)).toBeDefined();
      const dd = got.filter((g) => JSON.parse(g.body).type === "drawdown.state");
      expect(dd).toHaveLength(2);
      expect(JSON.parse(dd[0]!.body).data.to).toBe("paused");
      // Same event again (same block): not re-sent.
      await d.emit({ type: "drawdown.state", data: { account: acct, from: "normal", to: "paused", ddBps: -450, blockNumber: 123n } });
      expect(got.filter((g) => JSON.parse(g.body).type === "drawdown.state")).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
