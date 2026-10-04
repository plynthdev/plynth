// End to end on plain anvil + Postgres: the desk kit treasury (balanced template, $200k USDG). A $60k buy is
// over the $50k board threshold; the desk's simulation fails on rule 9, the jury (rule juror only: no Ollama
// here) deliberates, stores the bundle and opens a BoardApprovals ticket with keccak256(bundle) attached.
// The jury cannot approve; the board can, and then the op runs. Also cross-checks the rule juror's bandOk
// against PolicyGuard.bandOk on-chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, parseAbi, toBytes, type Hex } from "viem";
import { loadConfig } from "@/treasury/desks/runner-config";
import { accountAbi } from "@/abi/treasury-desks";
import { MemoryActionLog } from "@/treasury/desks/log";
import { attempt, deskIdBytes, equityRunData, executeArgs, wrapData, type DeskContext, type Op } from "@/treasury/desks/runner";
import { approvalsAbi } from "@/abi/treasury-jury";
import { juryApi } from "./api";
import { juryExceptionHandler } from "./desk";
import { bandOk } from "./rules";
import { JuryService } from "./service";
import { PgJuryStore } from "./store";
import type { JuryBundle } from "./types";
import { Kit, ROOT } from "@/testing/treasury-kit";

const PORT = 9550 + Math.floor(Math.random() * 40);
const RPC = `http://127.0.0.1:${PORT}`;
const FUNDING = 200_000n * 10n ** 6n;
const NO_OLLAMA = "http://127.0.0.1:9596"; // nothing listens here: rules-only

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let cfgPath: string;
let ready = false;
const logs: string[] = [];

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "BoardApprovals.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(ROOT, "contracts")], { stdout: "ignore", stderr: "ignore" });
  }
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "BoardApprovals.sol"))) return;
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
  dbUrl = withDatabase(databaseUrl(), `plynth_t_jury_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);
  cfgPath = await kit.setup(mkdtempSync(join(tmpdir(), "plynth-jury-")), FUNDING);
  ready = true;
}, 120_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

const store = () => new PgJuryStore(conn.db);
const jury = () => new JuryService({ ollama: { host: NO_OLLAMA }, store: store(), log: (m) => logs.push(m) });

function ctx(): DeskContext {
  return {
    chain: kit.chain,
    pub: kit.pub,
    cfg: loadConfig(cfgPath),
    cash: { account: kit.cashKey, wallet: kit.wallet(kit.cashKey) },
    equity: { account: kit.equityKey, wallet: kit.wallet(kit.equityKey) },
    log: new MemoryActionLog(),
    onException: juryExceptionHandler(jury(), store()),
  };
}

const bigBuy = (): Op => {
  const token = kit.stocks.find((s) => s.sym === "mTSLA")!.token;
  const usdg = 60_000n * 10n ** 6n;
  return { desk: "equity", action: "buy", adapter: kit.a.equitySleeve!, data: wrapData(kit.a.usdg!, usdg, equityRunData("buy", token, usdg, 100)), increased: token, asset: token, amount: usdg, usd: usdg * 10n ** 12n };
};

const rows = async () => (await conn.sql`select * from jury_verdicts order by id`) as unknown as Record<string, any>[];
const ticketCount = () => kit.pub.readContract({ address: kit.a.approvals!, abi: parseAbi(["function ticketCount() view returns (uint256)"]), functionName: "ticketCount" });
const T1 = `0x${"0".repeat(63)}1` as Hex;

describe("model jury on anvil", () => {
  test("rule juror bandOk matches PolicyGuard.bandOk on-chain (fuzz, 300 cases)", async () => {
    if (!ready) return;
    const abi = parseAbi(["struct Band { uint16 minBps; uint16 maxBps; }", "function bandOk(Band band, uint256 wBefore, uint256 wAfter) pure returns (bool)"]);
    let seed = 9;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const W = 10n ** 18n;
    const pick = (lo: number) => {
      const k = rnd(4);
      // Bias toward the band edges, where WAD truncation matters.
      if (k === 0) return (BigInt(lo) * W) / 10_000n + BigInt(rnd(3)) - 1n;
      return BigInt(rnd(10_001)) * 10n ** 14n + BigInt(rnd(1e9));
    };
    const cases = Array.from({ length: 300 }, () => {
      const min = rnd(10_001), max = min + rnd(10_001 - min);
      return { band: { minBps: min, maxBps: max }, b: pick(rnd(2) ? min : max), a: pick(rnd(2) ? min : max) };
    }).map((c) => ({ ...c, b: c.b < 0n ? 0n : c.b, a: c.a < 0n ? 0n : c.a }));
    for (let i = 0; i < cases.length; i += 50) {
      const chunk = cases.slice(i, i + 50);
      const onchain = await Promise.all(chunk.map((c) => kit.pub.readContract({ address: kit.a.guard!, abi, functionName: "bandOk", args: [c.band, c.b, c.a] })));
      chunk.forEach((c, j) => expect(bandOk(c.band, c.b, c.a)).toBe(onchain[j]!));
    }
  }, 60_000);

  test("a rule-9 rejection is filed: bundle stored, ticket opened with keccak256(bundle) as juryVerdictCid", async () => {
    if (!ready) return;
    const res = await attempt(ctx(), bigBuy());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rejection).toMatchObject({ code: 11, reason: "R9_APPROVAL" });

    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "requested", mode: "rules-only", recommendation: "none", rule_recommendation: "approve", desk: "equity", ticket: T1 });
    expect(r[0]!.bundle_hash).toBe(keccak256(toBytes(r[0]!.bundle_json)));
    expect(logs.some((m) => m.includes("rule juror only"))).toBe(true);

    const cid = await kit.pub.readContract({ address: kit.a.approvals!, abi: approvalsAbi, functionName: "juryVerdictCidOf", args: [T1] });
    expect(cid).toBe(r[0]!.bundle_hash);
    const t = await kit.pub.readContract({ address: kit.a.approvals!, abi: approvalsAbi, functionName: "ticketOf", args: [T1] });
    const opHash = await kit.pub.readContract({ address: kit.a.account!, abi: parseAbi(["function opHashOf(bytes32,address,bytes) view returns (bytes32)"]), functionName: "opHashOf", args: [deskIdBytes("equity"), kit.a.equitySleeve!, bigBuy().data] });
    expect(t.opHash).toBe(opHash);
    expect(t.status).toBe(1); // Requested: the jury's advice does not approve anything
    expect(t.requester.toLowerCase()).toBe(kit.equityKey.address.toLowerCase());

    const b = JSON.parse(r[0]!.bundle_json) as JuryBundle;
    expect(b.request).toMatchObject({ chainId: 31337, opHash, guard: { code: 11 }, intent: { action: "buy", notionalUsd: (60_000n * 10n ** 18n).toString() } });
    expect(b.request.policy).toMatchObject({ approvalAboveUsd: "50000", perOrderCapUsd: "100000", cash: { minBps: 4000, maxBps: 7000 } });
    expect(BigInt(b.request.weights.navUsd)).toBe(200_000n * 10n ** 18n);
    expect(b.rules.projected).toMatchObject({ cashBpsAfter: 7000, equityBpsAfter: 3000 });
  }, 60_000);

  test("the same op on the next pass is not filed again within the ticket TTL", async () => {
    if (!ready) return;
    await attempt(ctx(), bigBuy());
    expect(await rows()).toHaveLength(1);
    expect(await ticketCount()).toBe(1n);
  }, 60_000);

  test("board API serves the bundle verified against the on-chain cid; a tampered row is refused", async () => {
    if (!ready) return;
    const api = juryApi(store(), { pub: kit.pub });
    const ok = await api(new Request(`http://x/jury/tickets/31337/${kit.a.approvals}/1`));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).verified).toBe(true);
    const [row] = await rows();
    await conn.sql`update jury_verdicts set bundle_json = ${row!.bundle_json.replace('"rules-only"', '"models+rules"')} where id = ${row!.id}`;
    expect((await api(new Request(`http://x/jury/tickets/31337/${kit.a.approvals}/1`))).status).toBe(409);
    await conn.sql`update jury_verdicts set bundle_json = ${row!.bundle_json} where id = ${row!.id}`;
  }, 60_000);

  test("only the board approves: a desk key cannot; after the board approves, the op runs with the ticket", async () => {
    if (!ready) return;
    await expect(kit.send(kit.a.approvals!, "BoardApprovals.sol", "BoardApprovals", "approve", [T1], kit.equityKey)).rejects.toThrow();
    await kit.send(kit.a.approvals!, "BoardApprovals.sol", "BoardApprovals", "approve", [T1]); // deployer = board
    const c = ctx();
    const args = executeArgs(c, bigBuy());
    const hash = await kit.wallet(kit.equityKey).writeContract({ address: kit.a.account!, abi: accountAbi, functionName: "execute", args: [args[0], args[1], args[2], args[3], T1] });
    expect((await kit.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const t = await kit.pub.readContract({ address: kit.a.approvals!, abi: approvalsAbi, functionName: "ticketOf", args: [T1] });
    expect(t.status).toBe(4); // Consumed by the guard
  }, 60_000);
});

