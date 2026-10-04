// End to end on plain anvil: a balanced-template treasury funded with 100k USDG, the real sleeves, and
// `bun run treasury-desks --once` with time warps. Weights must end inside the bands; malicious calls are
// rejected by simulation and revert if forced on-chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringToHex, zeroHash, type Address } from "viem";
import { accountAbi, guardAbi, beaconAbi } from "@/abi/treasury-desks";
import { beaconKey, dayStart, DAY } from "./beacon";
import { loadConfig } from "./runner-config";
import { MemoryActionLog } from "./log";
import { attempt, equityRunData, executeArgs, wrapData, type DeskContext, type Op } from "./runner";
import { KEYS, Kit, ROOT } from "@/testing/treasury-kit";

const PORT = 9550 + Math.floor(Math.random() * 50);
const RPC = `http://127.0.0.1:${PORT}`;
const FUNDING = 100_000n * 10n ** 6n;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let cfgPath: string;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let ready = false;

function desks(): string {
  const r = Bun.spawnSync(["bun", "run", "--cwd", "app", "treasury-desks", "--once"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, TREASURY_CONFIG: cfgPath, TREASURY_RPC_URL: RPC, TREASURY_CASH_DESK_KEY: KEYS.cash, TREASURY_EQUITY_DESK_KEY: KEYS.equity },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`treasury-desks --once failed:\n${out}`);
  return out;
}

const rows = async () =>
  (await conn.sql`select desk, action, status, reason_code, reason, asset, beacon_key from desk_actions order by id`) as unknown as {
    desk: string;
    action: string;
    status: string;
    reason_code: number | null;
    reason: string | null;
    asset: string | null;
    beacon_key: string | null;
  }[];

async function snapshot() {
  return kit.pub.readContract({ address: kit.a.guard!, abi: guardAbi, functionName: "snapshot", args: [kit.a.account!] });
}

async function weights() {
  const s = await snapshot();
  const idle = s.raw[0]!; // USDG is the first tracked asset
  return { cash: Number((s.cashUsd * 10_000n) / s.nav), equity: Number((s.equityUsd * 10_000n) / s.nav), idleBps: Number((idle * 10n ** 12n * 10_000n) / s.nav), vaultShares: s.raw[1]!, nav: s.nav };
}

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "EquitySleeve.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "EquitySleeve.sol"))) return;
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
  const name = `plynth_t_desks_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  dbUrl = withDatabase(databaseUrl(), name);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);
  const dir = mkdtempSync(join(tmpdir(), "plynth-desks-"));
  cfgPath = await kit.setup(dir, FUNDING);
  ready = true;
}, 120_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

/** In-process context for the malicious-call checks (same simulate/attempt code the CLI uses). */
function ctx(log = new MemoryActionLog()): DeskContext {
  const cfg = loadConfig(cfgPath);
  return {
    chain: kit.chain,
    pub: kit.pub,
    cfg,
    cash: { account: kit.cashKey, wallet: kit.wallet(kit.cashKey) },
    equity: { account: kit.equityKey, wallet: kit.wallet(kit.equityKey) },
    log,
  };
}

const buyOp = (token: Address, usdg: bigint): Op => ({
  desk: "equity",
  action: "buy",
  adapter: kit.a.equitySleeve!,
  data: wrapData(kit.a.usdg!, usdg, equityRunData("buy", token, usdg, 100)),
  increased: token,
  asset: token,
  amount: usdg,
  usd: usdg * 10n ** 12n,
});

/** Sends `op` with a fixed gas limit so viem cannot refuse it at estimation: the chain must revert it. */
async function force(op: Op) {
  const c = ctx();
  const hash = await kit.wallet(kit.equityKey).writeContract({ address: kit.a.account!, abi: accountAbi, functionName: "execute", args: executeArgs(c, op), gas: 3_000_000n });
  return kit.pub.waitForTransactionReceipt({ hash });
}

describe("treasury desks on anvil (balanced template, 100k USDG)", () => {
  test("day 0: commits tomorrow's beacon; no rebalance; an out-of-band sweep is rejected by simulation and logged", async () => {
    if (!ready) return;
    const out = desks();
    expect(out).toContain("pass done");
    const r = await rows();
    expect(r.some((x) => x.action === "beacon_commit" && x.status === "sent")).toBe(true);
    expect(r.some((x) => x.action === "buy")).toBe(false);
    // Cash is 100% (> 70% max) and a vault deposit does not move it toward the band: rule 4.
    const dep = r.find((x) => x.desk === "cash" && x.action === "deposit");
    expect(dep).toMatchObject({ status: "rejected", reason_code: 6, reason: "R4_BAND" });
    expect((await weights()).vaultShares).toBe(0n);
  }, 60_000);

  test("malicious: a buy over the per-name float cap is rejected by simulation and reverts if forced", async () => {
    if (!ready) return;
    const spy = kit.stocks.find((s) => s.sym === "mSPY")!.token;
    const op = buyOp(spy, 40_000n * 10n ** 6n); // ~70 mSPY > 50 (1% of 5,000)
    const log = new MemoryActionLog();
    const res = await attempt(ctx(log), op);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.sent).toBe(false);
      expect(res.rejection.reason).toBe("FloatCapExceeded");
    }
    expect(log.rows[0]).toMatchObject({ status: "rejected", reason: "FloatCapExceeded", reasonCode: null });
    const before = await snapshot();
    const rcpt = await force(op);
    expect(rcpt.status).toBe("reverted");
    expect((await snapshot()).raw).toEqual(before.raw);
  }, 60_000);

  test("malicious: a buy over approvalAboveUsd (no board ticket) is rejected with R9 and reverts if forced", async () => {
    if (!ready) return;
    const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!.token;
    const op = buyOp(tsla, 60_000n * 10n ** 6n);
    const res = await attempt(ctx(), op);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rejection).toMatchObject({ code: 11, reason: "R9_APPROVAL" });
    expect((await force(op)).status).toBe("reverted");
  }, 60_000);

  test("malicious: a desk calling an adapter outside its scope is rejected with R1", async () => {
    if (!ready) return;
    const op: Op = { ...buyOp(kit.stocks[0]!.token, 1_000n * 10n ** 6n), desk: "cash" }; // cash key, equity sleeve
    const res = await attempt(ctx(), op);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rejection).toMatchObject({ code: 1, reason: "R1_DESK_SCOPE" });
  }, 60_000);

  test("day 1: reveal, rebalance at the beacon time, sweep; weights end inside the bands", async () => {
    if (!ready) return;
    const d1 = dayStart(await kit.now()) + DAY;
    await kit.warpTo(d1 + 60n);
    await kit.refreshFeeds();
    desks(); // reveals (and rebalances if the revealed time already passed)
    const key = beaconKey(kit.a.account!, d1);
    const b = await kit.pub.readContract({ address: kit.a.beacon!, abi: beaconAbi, functionName: "beacon", args: [key] });
    expect(b.executeAt).toBeGreaterThan(0n); // revealed
    expect(b.executeAt).toBeLessThan(d1 + DAY - 3600n);
    if ((await kit.now()) < b.executeAt) {
      // Not yet: nothing traded before the beacon time.
      expect((await rows()).some((x) => x.action === "buy" && x.status === "sent")).toBe(false);
      await kit.warpTo(b.executeAt);
      await kit.refreshFeeds();
      desks();
    }
    const r = await rows();
    const buys = r.filter((x) => x.action === "buy" && x.status === "sent");
    expect(buys.length).toBe(3);
    expect(r.some((x) => x.action === "rebalance_done" && x.beacon_key === key)).toBe(true);
    expect(r.some((x) => x.desk === "cash" && x.action === "deposit" && x.status === "sent")).toBe(true);
    const w = await weights();
    expect(w.equity).toBeGreaterThanOrEqual(3000);
    expect(w.equity).toBeLessThanOrEqual(6000);
    expect(w.cash).toBeGreaterThanOrEqual(4000);
    expect(w.cash).toBeLessThanOrEqual(7000);
    expect(w.idleBps).toBeGreaterThanOrEqual(199); // >= 2% NAV kept idle for fees
    expect(w.vaultShares).toBeGreaterThan(0n);
  }, 120_000);

  test("same day again: no second rebalance", async () => {
    if (!ready) return;
    const before = (await rows()).filter((x) => x.action === "buy").length;
    await kit.refreshFeeds();
    desks();
    expect((await rows()).filter((x) => x.action === "buy").length).toBe(before);
  }, 60_000);

  test("day 2: stale feeds skip the rebalance; after a 40% drop the desks redeem from the vault and rebuy", async () => {
    if (!ready) return;
    const d2 = dayStart(await kit.now()) + DAY;
    await kit.warpTo(d2 + 60n);
    await kit.refreshFeeds();
    desks(); // reveal day 2
    const key = beaconKey(kit.a.account!, d2);
    const b = await kit.pub.readContract({ address: kit.a.beacon!, abi: beaconAbi, functionName: "beacon", args: [key] });
    // Let every feed go stale (> 6h) and land past the execution time.
    await kit.warpTo((b.executeAt > d2 + 7n * 3600n ? b.executeAt : d2 + 7n * 3600n) + 1n);
    desks();
    const r1 = await rows();
    expect(r1.some((x) => x.action === "rebalance" && x.status === "skipped" && x.reason === "FEED_HOLD" && x.beacon_key === key)).toBe(true);
    expect(r1.some((x) => x.action === "rebalance_done" && x.beacon_key === key)).toBe(false);

    // Markets reopen with mAAPL down 40%: equity drifts, the desk buys mAAPL, the cash desk redeems first.
    await kit.refreshFeeds({ mAAPL: 138n * 10n ** 8n });
    const nBuys = r1.filter((x) => x.action === "buy" && x.status === "sent").length;
    desks();
    const r2 = await rows();
    const aapl = kit.stocks.find((s) => s.sym === "mAAPL")!.token.toLowerCase();
    expect(r2.filter((x) => x.action === "buy" && x.status === "sent").length).toBeGreaterThan(nBuys);
    expect(r2.some((x) => x.action === "buy" && x.status === "sent" && x.asset === aapl)).toBe(true);
    expect(r2.some((x) => x.action === "redeem" && x.status === "sent")).toBe(true);
    expect(r2.some((x) => x.action === "rebalance_done" && x.beacon_key === key)).toBe(true);
    const w = await weights();
    expect(w.equity).toBeGreaterThanOrEqual(3000);
    expect(w.equity).toBeLessThanOrEqual(6000);
    expect(w.cash).toBeGreaterThanOrEqual(4000);
    expect(w.cash).toBeLessThanOrEqual(7000);
    expect(w.idleBps).toBeGreaterThanOrEqual(199);
  }, 120_000);

  test("guard and account agree on NAV after all of it", async () => {
    if (!ready) return;
    const [nav] = await kit.pub.readContract({ address: kit.a.account!, abi: accountAbi, functionName: "navUsd" });
    expect(nav).toBe((await snapshot()).nav);
    void zeroHash;
    void stringToHex;
  });
});
