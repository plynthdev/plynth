// End to end on plain anvil: the desk kit treasury (balanced template, 100k USDG + some mTSLA) with a real
// PeriodClose. `bun run treasury:close --once` commits the period statement (and waits while a held feed is
// on hold); `bun run treasury:cfo-pack` renders it, and refuses once the stored bundle is tampered with.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@plynth/db";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { periodCloseAbi } from "../close/abi";
import { accountAbi } from "../desks/abi";
import { KEYS, Kit, ROOT } from "./kit";

const PORT = 9550 + Math.floor(Math.random() * 50);
const RPC = `http://127.0.0.1:${PORT}`;
const FUNDING = 100_000n * 10n ** 6n;
const PERIOD = 30n * 86_400n;
const FEE_TO = getAddress("0x00000000000000000000000000000000000fee70");

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let pc: Address;
let ready = false;

function run(script: string, args: string[] = []): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", "run", script, ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, TREASURY_RPC_URL: RPC, TREASURY_PERIOD_CLOSE: pc, TREASURY_CONTROLLER_KEY: KEYS.deployer },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

const read = <T>(fn: string, args: unknown[] = []) => kit.pub.readContract({ address: pc, abi: periodCloseAbi, functionName: fn as never, args: args as never }) as Promise<T>;
const closeRows = async () =>
  (await conn.sql`select status, period_end, bundle_hash, close_index, tx_hash from closes order by id`) as unknown as {
    status: string;
    period_end: string;
    bundle_hash: string;
    close_index: number | null;
    tx_hash: string | null;
  }[];

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "PeriodClose.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "PeriodClose.sol"))) return;
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
  const name = `plynth_t_close_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  dbUrl = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);
  await kit.setup(mkdtempSync(join(tmpdir(), "plynth-close-")), FUNDING);
  // Some equity so a held feed can be on hold: 40 mTSLA (~$10k).
  const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
  await kit.send(tsla.token, "MockStockToken.sol", "MockStockToken", "mint", [kit.a.account, 40n * 10n ** 18n]);
  pc = await kit.deploy("PeriodClose.sol", "PeriodClose", [kit.a.account, kit.a.usdg, FEE_TO]);
  await kit.send(kit.a.account!, "TreasuryAccount.sol", "TreasuryAccount", "setPeriodClose", [pc]);
  // One desk action in the period, logged as the desks would (a guard denial).
  await conn.sql`insert into desk_actions (chain_id, account, desk, action, status, reason_code, reason) values (31337, ${kit.a.account!.toLowerCase()}, 'cash', 'deposit', 'rejected', 6, 'R4_BAND')`;
  ready = true;
}, 120_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

describe("period close on anvil", () => {
  test("before the period ends: not due, nothing stored", async () => {
    if (!ready) return;
    const r = run("treasury:close", ["--once"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"status":"not_due"');
    expect(await closeRows()).toHaveLength(0);
  }, 60_000);

  test("period over but a held feed is on hold: no commit, the service waits", async () => {
    if (!ready) return;
    const start = await read<bigint>("startTime");
    await kit.warpTo(start + PERIOD + 3600n); // feeds left stale (Valuer staleness 6h is exceeded by the warp)
    const r = run("treasury:close", ["--once"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"status":"hold"');
    expect(await read<bigint>("closeCount")).toBe(0n);
  }, 60_000);

  test("markets reopen: the close commits; NAV, positions and fee match the chain", async () => {
    if (!ready) return;
    await kit.refreshFeeds();
    const r = run("treasury:close", ["--once"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('"status":"committed"');

    const latest = await read<{ periodEnd: bigint; navUsd: bigint; cashBps: number; equityBps: number; bundleHash: string }>("latest");
    const start = await read<bigint>("startTime");
    expect(latest.periodEnd).toBe(start + PERIOD);
    const [navNow] = await kit.pub.readContract({ address: kit.a.account!, abi: accountAbi, functionName: "navUsd" });
    const fee = await read<bigint>("feeFor", [latest.navUsd, PERIOD]);
    expect(fee).toBeGreaterThan(0n);
    expect(navNow).toBe(latest.navUsd - fee * 10n ** 12n); // NAV after paying the fee
    expect(await read<bigint>("periodStartNav")).toBe(navNow);
    const feeBal = await kit.read<bigint>(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "balanceOf", [FEE_TO]);
    expect(feeBal).toBe(fee);

    const rows = await closeRows();
    const committed = rows.filter((x) => x.status === "committed");
    expect(committed).toHaveLength(1);
    expect(committed[0]!.bundle_hash).toBe(latest.bundleHash.toLowerCase());
    expect(committed[0]!.close_index).toBe(0);

    // The next period is not due yet.
    const again = run("treasury:close", ["--once"]);
    expect(again.out).toContain('"status":"not_due"');
  }, 90_000);

  test("cfo-pack renders JSON, CSV and HTML only from the event + matching bundle", async () => {
    if (!ready) return;
    const out = mkdtempSync(join(tmpdir(), "plynth-cfo-"));
    const r = run("treasury:cfo-pack", ["--index", "0", "--out", out]);
    expect(r.code, r.out).toBe(0);
    const latest = await read<{ navUsd: bigint; bundleHash: string }>("latest");
    const j = JSON.parse(readFileSync(join(out, "statement.json"), "utf8"));
    expect(j.statement.navUsd).toBe(latest.navUsd.toString());
    expect(j.statement.bundleHash).toBe(latest.bundleHash);
    expect(j.positions.map((p: { symbol: string }) => p.symbol).sort()).toEqual(["mTSLA", "mUSDG"].sort());
    expect(j.guardDenials).toHaveLength(1);
    const csv = readFileSync(join(out, "positions.csv"), "utf8");
    expect(csv).toContain(`nav_usd_1e18,${latest.navUsd}`);
    const html = readFileSync(join(out, "statement.html"), "utf8");
    expect(html).toContain("Period statement #0");
    expect(html).not.toMatch(/<script|https?:\/\//i);

    // By period end as well (uses the committed row's block as a log-scan hint).
    const pe = (await read<{ periodEnd: bigint }>("latest")).periodEnd;
    const out2 = mkdtempSync(join(tmpdir(), "plynth-cfo-"));
    expect(run("treasury:cfo-pack", ["--period-end", pe.toString(), "--out", out2]).code).toBe(0);
  }, 60_000);

  test("tampered stored bundle: cfo-pack refuses and writes nothing", async () => {
    if (!ready) return;
    await conn.sql`update closes set bundle_json = replace(bundle_json, '"cashBps":', '"cashBps":1') where status = 'committed'`;
    const out = join(mkdtempSync(join(tmpdir(), "plynth-cfo-")), "pack");
    const r = run("treasury:cfo-pack", ["--index", "0", "--out", out]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("refused");
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});
