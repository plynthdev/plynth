// Todo 30 end to end: the MCP server on a factory-made treasury on anvil. Every tool is called through the
// official SDK client, over streamable HTTP and over stdio. Tokens are scoped to one treasury, revocable, and
// the only write (exceptions_request) files a request for the board without touching the chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BlockTimes, issueMcpToken, issueMessage, revokeMcpToken, revokeMessage, type ApiDeployment, type Deps } from "@/api";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { compileTemplate, policyAbiParam } from "@/treasury/policy-compiler";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventLog, encodeAbiParameters, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, KEYS, Kit, ROOT } from "@/testing/treasury-kit";
import { httpHandler } from "./server";

const PORT = 9800 + Math.floor(Math.random() * 40);
const RPC = `http://127.0.0.1:${PORT}`;
const MCP_SECRET = "mcp-e2e-secret-0123456789abcdef-0123456789"; // test-key (HMAC secret for MCP tokens)
const BOARD2 = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key (anvil #3)

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let d: Deps;
let acctA: Address;
let acctB: Address;
let server: ReturnType<typeof Bun.serve> | undefined;
let depPath: string;
let ready = false;

async function token(account: Address, board: ReturnType<typeof privateKeyToAccount>, label: string) {
  const now = Math.floor(Date.now() / 1000);
  const req = { label, issuedAt: now, expiresAt: now + 86_400 };
  const signature = await kit.wallet(board).signMessage({ account: board, message: issueMessage({ chainId: 31337, account, ...req }) });
  return issueMcpToken(d, account, { ...req, signature });
}

async function httpClient(tok: string) {
  const c = new Client({ name: "plinth-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server!.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }) as Parameters<Client["connect"]>[0]);
  return c;
}

const data = (r: any) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "Receipts.sol"))) return;
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
  dbUrl = withDatabase(databaseUrl(), `plynth_t_mcp_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);
  await kit.setup(mkdtempSync(join(tmpdir(), "plynth-mcp-")), 100_000n * 10n ** 6n, { factory: { feeTo: getAddress("0x00000000000000000000000000000000000fee31") } });
  acctA = kit.a.account!;
  // Treasury B: another board, same factory.
  const compiled = compileTemplate(kit.template as never, { controller: BOARD2.address });
  const r = await kit.send(kit.a.factory!, "TreasuryFactory.sol", "TreasuryFactory", "deploy", [encodeAbiParameters([policyAbiParam], [compiled.policy]), BOARD2.address], BOARD2);
  const { abi } = artifact("TreasuryFactory.sol", "TreasuryFactory");
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics }) as any;
      if (ev.eventName === "TreasuryCreated") acctB = ev.args.account;
    } catch {}
  }
  const dep: ApiDeployment = {
    vault: kit.a.usdg!,
    crowd: kit.a.usdg!,
    beacon: kit.a.usdg!,
    valuer: kit.a.valuer!,
    usdg: kit.a.usdg!,
    stocks: [],
    deployBlock: 0n,
    treasuryFactory: kit.a.factory!,
    treasuryFactoryBlock: kit.factoryBlock,
    receipts: kit.a.receipts!,
    templateRegistry: kit.a.templates!,
  };
  d = { chainId: 31337, pub: kit.pub, db: conn.db, dep, blockTimes: new BlockTimes(kit.pub), mcpSecret: MCP_SECRET };
  depPath = join(mkdtempSync(join(tmpdir(), "plynth-mcp-dep-")), "31337.json");
  writeFileSync(depPath, JSON.stringify({ valuer: kit.a.valuer, usdg: kit.a.usdg, treasuryFactory: kit.a.factory, treasuryFactoryBlock: String(kit.factoryBlock), receipts: kit.a.receipts, templateRegistry: kit.a.templates }));
  server = Bun.serve({ port: 0, fetch: httpHandler(d) });
  ready = true;
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

describe("MCP server over streamable HTTP", () => {
  test("lists exactly the five tools; four are read-only", async () => {
    if (!ready) return;
    const t = await token(acctA, kit.deployer, "list");
    const c = await httpClient(t.token);
    const tools = (await c.listTools()).tools;
    expect(tools.map((x) => x.name).sort()).toEqual(["close_latest", "exceptions_request", "nav", "policy", "positions"]);
    for (const x of tools) expect(x.annotations?.readOnlyHint).toBe(x.name !== "exceptions_request");
    for (const x of tools.filter((y) => y.name !== "exceptions_request")) expect(Object.keys((x.inputSchema as any).properties ?? {})).toEqual([]); // no account argument
    await c.close();
  }, 60_000);

  test("nav, positions, policy and close_latest return the token's treasury, matching the chain", async () => {
    if (!ready) return;
    const t = await token(acctA, kit.deployer, "read");
    const c = await httpClient(t.token);
    const nav = data(await c.callTool({ name: "nav", arguments: {} }));
    expect(nav.account).toBe(acctA);
    const [chainNav] = await kit.read<[bigint, boolean]>(acctA, "TreasuryAccount.sol", "TreasuryAccount", "navUsd");
    expect(BigInt(nav.navUsdRaw)).toBe(chainNav);
    const pos = data(await c.callTool({ name: "positions", arguments: {} }));
    expect(pos.positions.reduce((s: bigint, p: any) => s + BigInt(p.usdRaw), 0n)).toBe(chainNav);
    const pol = data(await c.callTool({ name: "policy", arguments: {} }));
    expect(pol.board).toBe(kit.deployer.address);
    expect(pol.version).toBe(1);
    const none = data(await c.callTool({ name: "close_latest", arguments: {} }));
    expect(none.close).toBeNull();

    // Commit a close, then close_latest returns it with its verified bundle.
    const start = await kit.read<bigint>(kit.a.periodClose!, "PeriodClose.sol", "PeriodClose", "startTime");
    await kit.warpTo(start + 30n * 86_400n + 60n);
    await kit.refreshFeeds();
    const r = Bun.spawnSync(["bun", "run", "--cwd", "app", "treasury-close", "--once"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl, TREASURY_RPC_URL: RPC, TREASURY_PERIOD_CLOSE: kit.a.periodClose!, TREASURY_CONTROLLER_KEY: KEYS.deployer },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stdout.toString()).toContain('"status":"committed"');
    const cl = data(await c.callTool({ name: "close_latest", arguments: {} }));
    expect(cl.close.index).toBe(0);
    expect(cl.bundleVerified).toBe(true);
    expect(cl.account).toBe(acctA);
    await c.close();
  }, 120_000);

  test("a token is scoped to its treasury: B's token sees B, never A", async () => {
    if (!ready) return;
    const t = await token(acctB, BOARD2, "b");
    const c = await httpClient(t.token);
    const nav = data(await c.callTool({ name: "nav", arguments: {} }));
    expect(nav.account).toBe(acctB);
    expect(nav.navUsdRaw).toBe("0");
    expect(data(await c.callTool({ name: "policy", arguments: {} })).board).toBe(BOARD2.address);
    await c.close();
    // A's board cannot issue a token for B.
    await expect(token(acctB, kit.deployer, "steal")).rejects.toThrow(/board/);
  }, 60_000);

  test("missing, forged, revoked or other-chain tokens get 401", async () => {
    if (!ready) return;
    const url = `http://127.0.0.1:${server!.port}/mcp`;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const post = (auth?: string) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(init) });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer pmcp_e30.AAAA")).status).toBe(401);
    const t = await token(acctA, kit.deployer, "revoke-me");
    expect((await post(`Bearer ${t.token}`)).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const sig = await kit.wallet(kit.deployer).signMessage({ account: kit.deployer, message: revokeMessage({ chainId: 31337, account: acctA, id: t.id, issuedAt: now }) });
    await revokeMcpToken(d, acctA, { id: t.id, issuedAt: now, signature: sig });
    const r = await post(`Bearer ${t.token}`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error).toBe("token revoked");
    // Same secret, another chain id: refused.
    const other = Bun.serve({ port: 0, fetch: httpHandler({ ...d, chainId: 46630 }) });
    try {
      const t2 = await token(acctA, kit.deployer, "chain");
      const r2 = await fetch(`http://127.0.0.1:${other.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t2.token}` }, body: JSON.stringify(init) });
      expect(r2.status).toBe(401);
    } finally {
      other.stop(true);
    }
  }, 60_000);

  test("exceptions_request files a pending request for the board, changes nothing on-chain, and is rate-limited", async () => {
    if (!ready) return;
    const t = await token(acctA, kit.deployer, "writer");
    const c = await httpClient(t.token);
    const block = await kit.pub.getBlockNumber();
    const r = data(await c.callTool({ name: "exceptions_request", arguments: { action: "buy", desk: "equity", asset: kit.stocks[0]!.token, amountUsd: "150000", reason: "One order above the per-order cap to finish the rebalance." } }));
    expect(r).toMatchObject({ status: "pending", needs: "board approval" });
    expect(await kit.pub.getBlockNumber()).toBe(block);
    const [row] = await conn.sql`select * from treasury_exception_requests where id = ${r.id}`;
    expect(row!.account).toBe(acctA.toLowerCase());
    expect(row!.token_id).toBe(t.id);
    expect(row!.asset).toBe(kit.stocks[0]!.token.toLowerCase());
    const bad = await c.callTool({ name: "exceptions_request", arguments: { action: "buy", reason: "too short" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as any)[0].text).toContain("reason");
    const badAsset = await c.callTool({ name: "exceptions_request", arguments: { action: "buy", asset: "nope", reason: "a reason that is long enough" } });
    expect(badAsset.isError).toBe(true);
    for (let i = 1; i < 20; i++) await c.callTool({ name: "exceptions_request", arguments: { action: "buy", reason: `request number ${i} for the board` } });
    const over = await c.callTool({ name: "exceptions_request", arguments: { action: "buy", reason: "the twenty-first pending request" } });
    expect(over.isError).toBe(true);
    expect((over.content as any)[0].text).toContain("pending requests");
    await c.close();
  }, 60_000);
});

describe("MCP server over stdio", () => {
  test("the same tools answer over stdio for the token in PLINTH_MCP_TOKEN", async () => {
    if (!ready) return;
    const t = await token(acctA, kit.deployer, "stdio");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "app", "src", "bin", "mcp.ts"), "--stdio"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RPC_URL: RPC, DATABASE_URL: dbUrl, MCP_TOKEN_SECRET: MCP_SECRET, PLINTH_MCP_TOKEN: t.token, DEPLOYMENT_JSON: depPath },
      stderr: "pipe",
    });
    const c = new Client({ name: "plinth-test-stdio", version: "1.0.0" });
    await c.connect(transport);
    try {
      const names = (await c.listTools()).tools.map((x) => x.name).sort();
      expect(names).toEqual(["close_latest", "exceptions_request", "nav", "policy", "positions"]);
      for (const name of ["nav", "positions", "policy", "close_latest"]) {
        const r = await c.callTool({ name, arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(data(r).account).toBe(acctA);
      }
      const ex = data(await c.callTool({ name: "exceptions_request", arguments: { action: "sell", reason: "filed over stdio for the board" } }));
      expect(ex.status).toBe("pending");
    } finally {
      await c.close();
    }
  }, 60_000);
});
