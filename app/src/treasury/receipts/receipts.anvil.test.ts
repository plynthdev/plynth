// Todo 30 on plain anvil + Postgres: the receipts service closes finished hours of desk_actions into Merkle
// roots and posts them to Receipts with the controller key; every action's proof verifies on-chain; a rewritten
// row no longer verifies. The valuer service writes NAV marks that equal the guard snapshot.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, navMarks, runMigrations, withDatabase } from "@/db";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptsAbi } from "@/abi/treasury-receipts";
import { receiptProof, receiptRoot, ReceiptNotFound } from "./proof";
import { receiptsOnce, type ReceiptsContext } from "./service";
import { ReceiptStore } from "./store";
import { markOnce, readMark, treasuriesFromEnv } from "@/treasury/valuer/service";
import { artifact, KEYS, Kit, ROOT } from "@/testing/treasury-kit";

const PORT = 9750 + Math.floor(Math.random() * 40);
const RPC = `http://127.0.0.1:${PORT}`;
const H = 3600;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let kit: Kit;
let dbUrl: string;
let conn: ReturnType<typeof connect>;
let acct: Address;
let ready = false;
let baseHour: number; // an hour that is over (wall clock) by a wide margin

async function addAction(createdAt: Date, over: Record<string, unknown> = {}) {
  const r = await conn.sql`insert into desk_actions (chain_id, account, desk, action, status, reason_code, reason, asset, amount, detail, created_at)
    values (31337, ${acct.toLowerCase()}, ${(over.desk as string) ?? "equity"}, 'buy', ${(over.status as string) ?? "sent"}, ${(over.reasonCode as number) ?? null},
            ${(over.reason as string) ?? null}, ${kit.stocks[0]!.token.toLowerCase()}, '1000', '{"k":1}'::jsonb, ${createdAt.toISOString()}::timestamptz) returning id`;
  return r[0]!.id as number;
}

function ctx(over: Partial<ReceiptsContext> = {}): ReceiptsContext {
  const controller = privateKeyToAccount(KEYS.deployer); // the kit's policy controller
  return {
    chain: kit.chain,
    pub: kit.pub,
    wallet: kit.wallet(controller),
    controller,
    receipts: kit.a.receipts!,
    store: new ReceiptStore(conn.db),
    accounts: [acct],
    graceSeconds: 300,
    ...over,
  };
}

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
  dbUrl = withDatabase(databaseUrl(), `plynth_t_receipts_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await createDatabaseIfMissing(dbUrl);
  await runMigrations(dbUrl);
  conn = connect(dbUrl);
  await kit.setup(mkdtempSync(join(tmpdir(), "plynth-receipts-")), 100_000n * 10n ** 6n, { factory: { feeTo: getAddress("0x00000000000000000000000000000000000fee30") } });
  acct = kit.a.account!;
  baseHour = Math.floor(Date.now() / 1000 / H) - 10;
  ready = true;
}, 240_000);

afterAll(async () => {
  anvil?.kill();
  await anvil?.exited;
  await conn?.close();
  if (dbUrl) await dropDatabase(dbUrl);
});

describe("hourly receipts", () => {
  test("finished hours with actions are built and posted; empty hours and the current hour are not", async () => {
    if (!ready) return;
    const t = (h: number, m: number) => new Date((baseHour + h) * H * 1000 + m * 60_000);
    const a1 = await addAction(t(0, 1));
    const a2 = await addAction(t(0, 30), { status: "rejected", reasonCode: 4, reason: "R3_ORDER_CAP" }); // a guard denial
    const a3 = await addAction(t(0, 59));
    const b1 = await addAction(t(3, 10)); // hours 1, 2 are empty
    const now = await addAction(new Date()); // the current hour: not over yet

    const out = await receiptsOnce(ctx());
    expect(out.map((o) => [Number(o.hour) - baseHour, o.status, o.leafCount])).toEqual([
      [0, "posted", 3],
      [3, "posted", 1],
    ]);
    const store = new ReceiptStore(conn.db);
    const r0 = (await store.get(31337, acct, BigInt(baseHour)))!;
    expect(r0.actionIds).toEqual([a1, a2, a3]);
    const onchain = await kit.pub.readContract({ address: kit.a.receipts!, abi: receiptsAbi, functionName: "receipt", args: [acct, BigInt(baseHour)] });
    expect(onchain.root).toBe(r0.root as `0x${string}`);
    expect(onchain.leafCount).toBe(3);
    expect(await store.get(31337, acct, BigInt(baseHour + 1))).toBeUndefined();
    const nowRow = await receiptProof({ pub: kit.pub, store, chainId: 31337, receipts: kit.a.receipts }, acct, now).catch((e) => e);
    expect(nowRow).toBeInstanceOf(ReceiptNotFound);
    expect(b1).toBeGreaterThan(a3);

    // Idempotent: a second pass posts nothing new.
    expect(await receiptsOnce(ctx())).toEqual([]);
  }, 60_000);

  test("every action's proof verifies on-chain (guard denials included); the root endpoint agrees with the chain", async () => {
    if (!ready) return;
    const store = new ReceiptStore(conn.db);
    const d = { pub: kit.pub, store, chainId: 31337, receipts: kit.a.receipts };
    const r0 = (await store.get(31337, acct, BigInt(baseHour)))!;
    for (const id of r0.actionIds) {
      const p = await receiptProof(d, acct, id);
      expect(p.verified).toBe(true);
      expect(p.verifiedOnchain).toBe(true);
      expect(p.root).toBe(r0.root);
    }
    const denied = await receiptProof(d, acct, r0.actionIds[1]!);
    expect(denied.row.status).toBe("rejected");
    expect(denied.row.reasonCode).toBe(4);
    const root = await receiptRoot(d, acct, BigInt(baseHour));
    expect(root.matchesRows).toBe(true);
    expect(root.matchesChain).toBe(true);
    await expect(receiptRoot(d, acct, BigInt(baseHour + 1))).rejects.toBeInstanceOf(ReceiptNotFound);
  }, 60_000);

  test("a desk action rewritten after its hour was posted no longer verifies", async () => {
    if (!ready) return;
    const store = new ReceiptStore(conn.db);
    const d = { pub: kit.pub, store, chainId: 31337, receipts: kit.a.receipts };
    const r0 = (await store.get(31337, acct, BigInt(baseHour)))!;
    const victim = r0.actionIds[1]!;
    await conn.sql`update desk_actions set status = 'sent', reason_code = null, reason = null where id = ${victim}`;
    const p = await receiptProof(d, acct, victim);
    expect(p.verified).toBe(false);
    expect(p.verifiedOnchain).toBe(false);
    expect((await receiptRoot(d, acct, BigInt(baseHour))).matchesRows).toBe(false);
    // Restoring the row restores the proof: the receipt commits to content, not to row ids.
    await conn.sql`update desk_actions set status = 'rejected', reason_code = 4, reason = 'R3_ORDER_CAP' where id = ${victim}`;
    expect((await receiptProof(d, acct, victim)).verified).toBe(true);
  }, 60_000);

  test("only the policy's controller can post: another key's post fails and is retried later", async () => {
    if (!ready) return;
    const h = baseHour + 5;
    await addAction(new Date(h * H * 1000 + 60_000));
    const stranger = privateKeyToAccount(KEYS.cash);
    const bad = await receiptsOnce(ctx({ controller: stranger, wallet: kit.wallet(stranger) }));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.status).toBe("failed");
    expect(bad[0]!.error).toBe("NotController");
    const row = (await new ReceiptStore(conn.db).get(31337, acct, BigInt(h)))!;
    expect(row.status).toBe("failed");
    // The real controller's next pass posts the stored (unchanged) root.
    const good = await receiptsOnce(ctx());
    expect(good.map((g) => [Number(g.hour), g.status])).toEqual([[h, "posted"]]);
  }, 60_000);

  test("a root already on-chain that differs from the stored one is flagged, never overwritten", async () => {
    if (!ready) return;
    const h = baseHour + 6;
    // Someone holding the controller key posted a different root for the hour first.
    await kit.send(kit.a.receipts!, "Receipts.sol", "Receipts", "post", [acct, BigInt(h), `0x${"11".repeat(32)}`, 1]);
    await addAction(new Date(h * H * 1000 + 60_000));
    const out = await receiptsOnce(ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.error).toContain("differs");
    const onchain = await kit.pub.readContract({ address: kit.a.receipts!, abi: receiptsAbi, functionName: "receipt", args: [acct, BigInt(h)] });
    expect(onchain.root).toBe(`0x${"11".repeat(32)}`);
  }, 60_000);

  test("the grace period keeps a just-finished hour open for late rows", async () => {
    if (!ready) return;
    const store = new ReceiptStore(conn.db);
    const nowS = Math.floor(Date.now() / 1000);
    const lastHour = Math.floor(nowS / H) - 1;
    await conn.sql`delete from desk_actions where created_at >= ${new Date((baseHour + 7) * H * 1000).toISOString()}::timestamptz`; // drop the current-hour row
    await addAction(new Date(lastHour * H * 1000 + 1000));
    await kit.warpTo(BigInt((lastHour + 1) * H + 400)); // chain clock past both "now"s below (only the wall clock is under test)
    // "now" = 2 minutes after lastHour ended: inside a 5-minute grace -> not closed yet.
    await receiptsOnce(ctx({ now: () => new Date((lastHour + 1) * H * 1000 + 120_000) }));
    expect(await store.get(31337, acct, BigInt(lastHour))).toBeUndefined();
    await receiptsOnce(ctx({ now: () => new Date((lastHour + 1) * H * 1000 + 301_000) }));
    expect((await store.get(31337, acct, BigInt(lastHour)))?.status).toBe("posted");
  }, 60_000);

  test("Receipts ABI subset matches the compiled contract", () => {
    if (!ready) return;
    const names = new Set(artifact("Receipts.sol", "Receipts").abi.map((x: any) => x.name));
    for (const x of receiptsAbi as readonly any[]) expect(names.has(x.name)).toBe(true);
  });
});

describe("valuer marks", () => {
  test("a mark equals the guard snapshot at its block and lands in nav_marks", async () => {
    if (!ready) return;
    const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
    await kit.send(tsla.token, "MockStockToken.sol", "MockStockToken", "mint", [acct, 10n * 10n ** 18n]);
    const r = await markOnce({ pub: kit.pub, db: conn.db, chainId: 31337, accounts: [acct] });
    expect(r.errors).toEqual([]);
    const [row] = await conn.db.select().from(navMarks).where(eq(navMarks.account, acct.toLowerCase()));
    const snap = (await kit.pub.readContract({ address: kit.a.guard!, abi: artifact("PolicyGuard.sol", "PolicyGuard").abi, functionName: "snapshot", args: [acct], blockNumber: row!.blockNumber })) as any;
    expect(row!.navUsd).toBe(snap.nav.toString());
    expect(row!.cashBps).toBe(Number((snap.cashUsd * 10_000n) / snap.nav));
    expect(row!.equityBps).toBe(Number((snap.equityUsd * 10_000n) / snap.nav));
    expect(row!.hold).toBe(snap.equityHold);
    const w = row!.weights as { asset: string; usd: string }[];
    expect(w.reduce((s, x) => s + BigInt(x.usd), 0n)).toBe(snap.nav);
    expect(w.find((x) => x.asset === tsla.token.toLowerCase())).toBeDefined();
  }, 60_000);

  test("a feed on hold is recorded as a hold flag", async () => {
    if (!ready) return;
    await kit.warpTo((await kit.now()) + 7n * 3600n); // feeds older than the valuer's 6 h max age
    const m = await readMark(kit.pub, 31337, acct);
    expect(m.hold).toBe(true);
    await kit.refreshFeeds();
    expect((await readMark(kit.pub, 31337, acct)).hold).toBe(false);
  }, 60_000);

  test("one unreadable treasury does not stop the others; the factory list is discovered", async () => {
    if (!ready) return;
    const accounts = await treasuriesFromEnv(kit.pub, { TREASURY_FACTORY: kit.a.factory });
    expect(accounts).toEqual([acct]);
    const before = (await conn.db.select().from(navMarks)).length;
    const r = await markOnce({ pub: kit.pub, db: conn.db, chainId: 31337, accounts: [kit.a.usdg!, acct] });
    expect(r.errors.map((e) => e.account)).toEqual([kit.a.usdg!]);
    expect((await conn.db.select().from(navMarks)).length).toBe(before + 1);
    await expect(treasuriesFromEnv(kit.pub, {})).rejects.toThrow(/TREASURY_ACCOUNTS/);
  }, 60_000);
});
