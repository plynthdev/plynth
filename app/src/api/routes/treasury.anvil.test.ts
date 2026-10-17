// Todo 14 end to end on plain anvil: a treasury built by TreasuryFactory (balanced template, 100k USDG + 40 mTSLA),
// the desks (todo 12) and the close service (todo 13) run once, then every treasury endpoint is read and checked
// against the chain and against each other. Also: treasury.create / policy.propose return transactions that the
// board can send as-is, and the signed webhooks fire for guard.denied, close.committed and drawdown.state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, treasuryMcpTokens, withDatabase } from "@/db";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventLog, getAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebhookDispatcher, WebhookStore } from "@/treasury/webhooks/dispatcher";
import { receiptsOnce } from "@/treasury/receipts/service";
import { ReceiptStore } from "@/treasury/receipts/store";
import { fileExceptionRequest, issueMessage, revokeMessage, signToken } from "@/api";
import { KEYS, Kit, ROOT } from "@/testing/treasury-kit";
import { BlockTimes, createApp, factoryAbi, templateHashOf, type ApiDeployment } from "@/api";
import { artifact } from "@/testing/treasury-kit";
import { compileTemplate } from "@/treasury/policy-compiler";

const PORT = 9700 + Math.floor(Math.random() * 50);
const RPC = `http://127.0.0.1:${PORT}`;
const FUNDING = 100_000n * 10n ** 6n;
const PERIOD = 30n * 86_400n;
const FEE_TO = getAddress("0x00000000000000000000000000000000000fee14");
const BOARD2 = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key (anvil #3)
const SECRET = "whsec-test-0123456789abcdef"; // test-key (HMAC secret for a local receiver)
const MCP_SECRET = "mcp-test-secret-0123456789abcdef-0123456789"; // test-key (HMAC secret for MCP tokens)

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let app: ReturnType<typeof createApp>;
let acct: Address;
let cfgPath: string;
let ready = false;
let deps: Parameters<typeof createApp>[0];
let receiptHour: bigint;
/** An MCP token for `acct`: the off-chain treasury records need one (audit L-14). */
const READER_ID = "ab".repeat(16);
let reader = "";
const auth = () => (reader ? { authorization: `Bearer ${reader}` } : {});

function run(script: string, args: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", "run", "--cwd", "app", script, ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl, TREASURY_RPC_URL: RPC, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${script} failed:\n${out}`);
  return out;
}

async function trpc(path: string, input: unknown, method: "GET" | "POST" = "GET") {
  const r =
    method === "GET"
      ? await app.request(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: auth() })
      : await app.request(`/trpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", ...auth() } });
  const j = (await r.json()) as any;
  return { status: r.status, data: j.result?.data, error: j.error };
}
async function ok(path: string, input: unknown, method: "GET" | "POST" = "GET") {
  const r = await trpc(path, input, method);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data;
}
async function rest(path: string, init?: RequestInit) {
  const r = await app.request(path, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), ...auth() } });
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
  run("treasury-desks", ["--once"], { TREASURY_CONFIG: cfgPath, TREASURY_CASH_DESK_KEY: KEYS.cash, TREASURY_EQUITY_DESK_KEY: KEYS.equity });
  await conn.sql`insert into desk_actions (chain_id, account, desk, action, status, reason_code, reason, asset) values (31337, ${acct.toLowerCase()}, 'equity', 'buy', 'rejected', 4, 'R3_ORDER_CAP', ${tsla.token.toLowerCase()})`;
  await conn.sql`insert into exceptions (chain_id, account, kind, key, venue, detail, status) values (31337, ${acct.toLowerCase()}, 'reconcile.position', 'reconcile.position:v:u', '0x00000000000000000000000000000000000000aa', '{"diff":"1"}', 'resolved')`;

  // Close service (todo 13) once, after the period with fresh feeds.
  const start = await kit.read<bigint>(kit.a.periodClose!, "PeriodClose.sol", "PeriodClose", "startTime");
  await kit.warpTo(start + PERIOD + 60n);
  await kit.refreshFeeds();
  // Hourly receipts (todo 30) for the period's desk actions, posted before the close so the bundle carries them.
  const chainNow = await kit.now();
  const posted = await receiptsOnce({
    chain: kit.chain,
    pub: kit.pub,
    wallet: kit.wallet(kit.deployer),
    controller: kit.deployer,
    receipts: kit.a.receipts!,
    store: new ReceiptStore(conn.db),
    accounts: [acct],
    graceSeconds: 0,
    now: () => new Date(Number(chainNow) * 1000),
  });
  if (!posted.length || posted.some((p) => p.status !== "posted")) throw new Error(`receipts not posted: ${JSON.stringify(posted, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  receiptHour = posted[0]!.hour;
  const out = run("treasury-close", ["--once"], { TREASURY_PERIOD_CLOSE: kit.a.periodClose!, TREASURY_CONTROLLER_KEY: KEYS.deployer });
  if (!out.includes('"status":"committed"')) throw new Error(`close did not commit:\n${out}`);

  const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const dep: ApiDeployment = {
    vault: A(1),
    crowd: A(2),
    beacon: A(3),
    valuer: kit.a.valuer!,
    usdg: kit.a.usdg!,
    stocks: [],
    deployBlock: 0n,
    treasuryFactory: kit.a.factory!,
    treasuryFactoryBlock: kit.factoryBlock,
    receipts: kit.a.receipts!,
    templateRegistry: kit.a.templates!,
  };
  deps = { chainId: 31337, pub: kit.pub, db: conn.db, dep, blockTimes: new BlockTimes(kit.pub), mcpSecret: MCP_SECRET };
  app = createApp(deps);
  await conn.db.insert(treasuryMcpTokens).values({ id: READER_ID, chainId: 31337, account: acct.toLowerCase(), label: "test reader", issuedBy: kit.deployer.address.toLowerCase(), expiresAt: new Date(Date.now() + 86_400_000) });
  reader = signToken(MCP_SECRET, { v: 1, jti: READER_ID, chainId: 31337, account: acct, exp: Math.floor(Date.now() / 1000) + 86_400 });
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
    expect((await app.request(`/v1/treasury/${acct}/cfo-pack/${c.periodEndUnix}/download?format=html`)).status).toBe(401);
    const dl = await app.request(`/v1/treasury/${acct}/cfo-pack/${c.periodEndUnix}/download?format=html`, { headers: auth() });
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
    // close.list is a private record (review v2 V2-L15): the reader token is for the other treasury
    expect((await trpc("close.list", { account: a.account })).status).toBe(401);
    // The REST mirror and template listing.
    expect((await rest("/v1/treasury/templates")).body.map((x: any) => x.name)).toEqual(["balanced", "carry", "conservative"]);
    const bad = await rest("/v1/treasury/create", { method: "POST", body: JSON.stringify({ templateName: "nope", controller: kit.deployer.address, board: BOARD2.address }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
  }, 60_000);

  test("anything that is not a treasury account is a 404", async () => {
    if (!ready) return;
    for (const p of ["nav.latest", "positions.list", "policy.current"]) {
      expect((await trpc(p, { account: kit.a.usdg })).status).toBe(404);
    }
    // private reads answer 401 first: a token for one treasury says nothing about any other address
    for (const p of ["desk.list", "close.list"]) expect((await trpc(p, { account: kit.a.usdg })).status).toBe(401);
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
      const store = new WebhookStore(conn.db, { allowPrivate: true }); // the receiver is on 127.0.0.1
      await store.add(31337, acct, `http://127.0.0.1:${server.port}/hook`, SECRET, ["guard.denied", "close.committed", "drawdown.state"]);
      await expect(store.add(31337, acct, "http://example.com/hook", SECRET, ["guard.denied"])).rejects.toThrow(/https/);
      await expect(store.add(31337, acct, "https://example.com/hook", "short", ["guard.denied"])).rejects.toThrow(/secret/);
      await expect(store.add(31337, acct, "https://example.com/hook", SECRET, ["nope"])).rejects.toThrow(/unknown/);
      expect((await store.list(31337, acct))[0]).not.toHaveProperty("secret");

      const d = new WebhookDispatcher(conn.db, { chainId: 31337, backoffMs: 10, allowPrivate: true });
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

describe("todo 30: receipts, NAV marks, marketplace, MCP tokens", () => {
  test("receipts.root / receipts.proof match the chain, and the close bundle carries the period's receipt roots", async () => {
    if (!ready) return;
    const root = await ok("receipts.root", { account: acct, hour: receiptHour.toString() });
    expect(root.matchesRows).toBe(true);
    expect(root.matchesChain).toBe(true);
    expect(root.status).toBe("posted");
    const n = Number((await conn.sql`select count(*)::int as n from desk_actions where account = ${acct.toLowerCase()}`)[0]!.n);
    expect(root.leafCount).toBe(n); // every desk action of the period happened in that one hour, denial included
    for (const id of root.actionIds) {
      const p = await ok("receipts.proof", { account: acct, actionId: id });
      expect(p.verifiedOnchain).toBe(true);
      expect(p.root).toBe(root.root);
    }
    const denial = (await conn.sql`select id from desk_actions where reason_code = 4 and account = ${acct.toLowerCase()}`)[0]!.id as number;
    const rest1 = await rest(`/v1/treasury/${acct}/actions/${denial}/proof`);
    expect(rest1.status).toBe(200);
    expect(rest1.body.row.reason).toBe("R3_ORDER_CAP");
    expect((await rest(`/v1/treasury/${acct}/receipts/${receiptHour}`)).body).toEqual(root);
    expect((await trpc("receipts.root", { account: acct, hour: "1" })).status).toBe(404);
    expect((await trpc("receipts.proof", { account: acct, actionId: 999999 })).status).toBe(404);

    const got = await ok("close.get", { account: acct, index: 0 });
    expect(got.bundleVerified).toBe(true);
    expect(got.bundle.receipts).toEqual([{ hour: receiptHour.toString(), root: root.root.toLowerCase(), leafCount: root.leafCount, txHash: root.txHash }]);
  }, 60_000);

  test("nav.history reads the valuer's 60 s marks, newest first", async () => {
    if (!ready) return;
    for (let i = 0; i < 2; i++) run("treasury-marks", ["--once"], { TREASURY_ACCOUNTS: acct });
    const h = await ok("nav.history", { account: acct });
    expect(h.points.length).toBe(2);
    expect(Date.parse(h.points[0].at)).toBeGreaterThanOrEqual(Date.parse(h.points[1].at));
    const nav = await ok("nav.latest", { account: acct });
    expect(h.points[0].navUsdRaw).toBe(nav.navUsdRaw);
    expect(h.points[0].cashBps).toBe(nav.bands.cash.bps);
    expect(h.points[0].equityBps).toBe(nav.bands.equity.bps);
    expect(h.points[0].hold).toBe(nav.hold);
    expect((await ok("nav.history", { account: acct, limit: 1 })).points).toHaveLength(1);
    expect((await ok("nav.history", { account: acct, from: new Date(Date.now() + 3_600_000).toISOString() })).points).toHaveLength(0);
    expect((await rest(`/v1/treasury/${acct}/nav/history?limit=1`)).body.points).toHaveLength(1);
  }, 60_000);

  test("marketplace: listed templates by staking priority; create from a template records its id; mismatches are refused", async () => {
    if (!ready) return;
    const reg = kit.a.templates!;
    const compiled = compileTemplate(kit.template as never, { controller: kit.deployer.address });
    const tHash = templateHashOf(compiled.policy);
    expect(tHash).toBe(await kit.read(kit.a.factory!, "TreasuryFactory.sol", "TreasuryFactory", "templateHash", [compiled.policy]));
    await kit.send(reg, "TemplateRegistry.sol", "TemplateRegistry", "submit", [tHash, "ipfs://balanced-local"]); // id 1, author = deployer
    await kit.send(reg, "TemplateRegistry.sol", "TemplateRegistry", "submit", [`0x${"22".repeat(32)}`, "ipfs://other"]); // id 2, never listed
    expect((await ok("marketplace.list", {})).templates).toEqual([]);
    await kit.send(reg, "TemplateRegistry.sol", "TemplateRegistry", "list", [1n]); // committee = deployer in the kit
    const m = await ok("marketplace.list", {});
    expect(m.templates).toHaveLength(1);
    expect(m.templates[0]).toMatchObject({ id: 1, author: kit.deployer.address, policyHash: tHash, metadataURI: "ipfs://balanced-local", priority: 0 });
    expect((await rest("/v1/treasury/marketplace")).body).toEqual(m);

    // Priority ordering: a registry with a tier source ranks a higher-tier author first.
    const tiers = await kit.deploy("Marketplace.t.sol", "MockTiers");
    const reg2 = await kit.deploy("TemplateRegistry.sol", "TemplateRegistry", [kit.deployer.address, tiers]);
    for (const [author, h] of [[kit.deployer, "33"], [BOARD2, "44"]] as const) {
      await kit.send(reg2, "TemplateRegistry.sol", "TemplateRegistry", "submit", [`0x${h.repeat(32)}`, `ipfs://${h}`], author);
    }
    await kit.send(reg2, "TemplateRegistry.sol", "TemplateRegistry", "list", [1n]);
    await kit.send(reg2, "TemplateRegistry.sol", "TemplateRegistry", "list", [2n]);
    await kit.send(tiers, "Marketplace.t.sol", "MockTiers", "set", [BOARD2.address, 2]);
    const app2 = createApp({ ...deps, dep: { ...deps.dep, templateRegistry: reg2 } });
    const r2 = (await (await app2.request("/v1/treasury/marketplace")).json()) as any;
    expect(r2.templates.map((t: any) => [t.id, t.priority])).toEqual([[2, 2], [1, 0]]);

    // Create from template 1: the board's tx goes through deployFromTemplate and records the id.
    const t = await ok("treasury.create", { template: kit.template, controller: BOARD2.address, board: BOARD2.address, templateId: 1 }, "POST");
    expect(t.templateId).toBe(1);
    expect(t.templateHash).toBe(tHash); // another controller, same template
    const hash = await kit.wallet(BOARD2).sendTransaction({ to: t.tx.to, data: t.tx.data });
    expect((await kit.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await kit.read<bigint>(kit.a.factory!, "TreasuryFactory.sol", "TreasuryFactory", "templateOf", [t.predicted.account])).toBe(1n);

    const changed = { ...kit.template, limits: { ...(kit.template.limits as object), perOrderUsd: 50_000 } };
    const bad = await trpc("treasury.create", { template: changed, controller: BOARD2.address, board: BOARD2.address, templateId: 1 }, "POST");
    expect(bad.status).toBe(400);
    expect(bad.error.message).toContain("does not match template 1");
    expect((await trpc("treasury.create", { template: kit.template, controller: BOARD2.address, board: BOARD2.address, templateId: 2 }, "POST")).status).toBe(400);
  }, 120_000);

  test("MCP tokens: only the board's signature issues one, a signed request works once, revocation sticks", async () => {
    if (!ready) return;
    const now = Math.floor(Date.now() / 1000);
    const req = { label: "ops agent", issuedAt: now, expiresAt: now + 7 * 86_400 };
    const msg = issueMessage({ chainId: 31337, account: acct, ...req });
    const signature = await kit.wallet(kit.deployer).signMessage({ account: kit.deployer, message: msg }); // board = deployer
    const issued = await ok("mcpTokens.issue", { account: acct, ...req, signature }, "POST");
    expect(issued.token).toMatch(/^pmcp_/);
    expect(issued.id).toMatch(/^[0-9a-f]{32}$/);
    // Replay of the same signed request: refused.
    expect((await trpc("mcpTokens.issue", { account: acct, ...req, signature }, "POST")).status).toBe(400);
    // Someone else's signature: 401.
    const other = await kit.wallet(BOARD2).signMessage({ account: BOARD2, message: msg });
    expect((await trpc("mcpTokens.issue", { account: acct, ...req, signature: other }, "POST")).status).toBe(401);
    // Stale request, too long a life, bad label: 400.
    const old = { ...req, issuedAt: now - 3600 };
    const oldSig = await kit.wallet(kit.deployer).signMessage({ account: kit.deployer, message: issueMessage({ chainId: 31337, account: acct, ...old }) });
    expect((await trpc("mcpTokens.issue", { account: acct, ...old, signature: oldSig }, "POST")).status).toBe(400);
    const long = { ...req, expiresAt: now + 91 * 86_400 };
    const longSig = await kit.wallet(kit.deployer).signMessage({ account: kit.deployer, message: issueMessage({ chainId: 31337, account: acct, ...long }) });
    expect((await trpc("mcpTokens.issue", { account: acct, ...long, signature: longSig }, "POST")).status).toBe(400);
    // No secret configured: 503.
    const noSecret = createApp({ ...deps, mcpSecret: undefined });
    const r503 = await noSecret.request(`/v1/treasury/${acct}/mcp-tokens`, { method: "POST", body: JSON.stringify({ ...req, signature }), headers: { "content-type": "application/json" } });
    expect(r503.status).toBe(503);

    const list = await ok("mcpTokens.list", { account: acct });
    expect(list.tokens.map((x: any) => x.id)).toEqual([issued.id, READER_ID]);
    expect(JSON.stringify(list)).not.toContain(issued.token);
    const rv = { id: issued.id, issuedAt: now };
    const rvSig = await kit.wallet(kit.deployer).signMessage({ account: kit.deployer, message: revokeMessage({ chainId: 31337, account: acct, ...rv }) });
    expect((await rest(`/v1/treasury/${acct}/mcp-tokens/${issued.id}/revoke`, { method: "POST", body: JSON.stringify({ issuedAt: now, signature: rvSig }), headers: { "content-type": "application/json" } })).status).toBe(200);
    expect((await ok("mcpTokens.list", { account: acct })).tokens[0].revokedAt).not.toBeNull();
  }, 60_000);

  test("audit L-14: off-chain records need an MCP token for that treasury; chain-derived reads stay public", async () => {
    if (!ready) return;
    const bare = async (path: string, headers: Record<string, string> = {}) => (await app.request(path, { headers })).status;
    // review v2 V2-L15: desks, closes and the CFO pack carry desk decisions and pending rows too
    for (const p of [`/v1/treasury/${acct}/actions`, `/v1/treasury/${acct}/exceptions`, `/v1/treasury/${acct}/mcp-tokens`, `/v1/treasury/${acct}/actions/1/proof`, `/v1/treasury/${acct}/desks`, `/v1/treasury/${acct}/closes`, `/v1/treasury/${acct}/closes/0`]) {
      expect(await bare(p)).toBe(401);
      expect(await bare(p, { authorization: "Bearer pmcp_forged.AAAA" })).toBe(401);
      expect(await bare(p, { authorization: `Bearer ${reader}` })).not.toBe(401);
    }
    expect((await app.request(`/trpc/actions.list?input=${encodeURIComponent(JSON.stringify({ account: acct }))}`)).status).toBe(401);
    // a token for another treasury does not open this one
    const otherId = "cd".repeat(16);
    const other = getAddress("0x00000000000000000000000000000000000a11ce");
    await conn.db.insert(treasuryMcpTokens).values({ id: otherId, chainId: 31337, account: other.toLowerCase(), label: "other", issuedBy: other.toLowerCase(), expiresAt: new Date(Date.now() + 86_400_000) });
    const otherTok = signToken(MCP_SECRET, { v: 1, jti: otherId, chainId: 31337, account: other, exp: Math.floor(Date.now() / 1000) + 86_400 });
    expect(await bare(`/v1/treasury/${acct}/actions`, { authorization: `Bearer ${otherTok}` })).toBe(401);
    // a revoked token stops working (before: it passes auth and the route answers 404, not a treasury)
    expect(await bare(`/v1/treasury/${other}/actions`, { authorization: `Bearer ${otherTok}` })).toBe(404);
    await conn.sql`update treasury_mcp_tokens set revoked_at = now() where id = ${otherId}`;
    expect(await bare(`/v1/treasury/${other}/actions`, { authorization: `Bearer ${otherTok}` })).toBe(401);
    // public by design: derived from the chain
    for (const p of [`/v1/treasury/${acct}/nav`, `/v1/treasury/${acct}/positions`, `/v1/treasury/${acct}/policy`]) expect(await bare(p)).toBe(200);
  }, 60_000);

  test("exception requests filed for the board show up in exceptions.list and never touch the chain", async () => {
    if (!ready) return;
    const block = await kit.pub.getBlockNumber();
    const r = await fileExceptionRequest(deps, acct, "0123456789abcdef0123456789abcdef", { action: "buy", desk: "equity", amountUsd: "150000", reason: "Rebalance needs one order above the per-order cap." });
    expect(r.status).toBe("pending");
    expect(await kit.pub.getBlockNumber()).toBe(block);
    const ex = await ok("exceptions.list", { account: acct });
    expect(ex.requests[0]).toMatchObject({ id: r.id, action: "buy", desk: "equity", amountUsd: "150000", status: "pending" });
    await expect(fileExceptionRequest(deps, acct, "x", { action: "Buy!", reason: "long enough reason" })).rejects.toThrow(/action/);
    await expect(fileExceptionRequest(deps, acct, "x", { action: "buy", reason: "short" })).rejects.toThrow(/reason/);
  }, 60_000);

  test("new ABI subsets exist in the compiled contracts", () => {
    if (!ready) return;
    const names = (file: string, c: string) => new Set(artifact(file, c).abi.map((x: any) => x.name));
    const f = names("TreasuryFactory.sol", "TreasuryFactory");
    for (const x of factoryAbi as readonly any[]) expect(f.has(x.name)).toBe(true);
  });
});
