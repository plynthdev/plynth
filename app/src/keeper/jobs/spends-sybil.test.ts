// Review v2, V2-M5 (KEEP-3 / KEEP-4). Before the fix, sybils with 1 USDG each (roundTo 1, rows of $x.99: every row a
// real 1-cent accrual, never a no-op) bought 200 sequential keeper transactions per pass: 20 sybils, 20 USDG that is
// not lost, 600 keeper transactions in 3 passes. Now an imported accrual must round up at least $0.25, each user gets
// at most KEEPER_MAX_ACCRUALS_PER_USER_PASS per pass, and the job stops at its wall-clock and gas budget.
// Real Postgres (roundup_sources / roundup_events) + a fake vault and a counting sender (harness from spends-budget).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex, type Address } from "viem";
import type { Ctx, KeeperDeployment } from "@/keeper/context";
import { AccrueGate, roundUpOf } from "@/keeper/sources/accrue";
import { insertEvents, upsertSource } from "@/keeper/sources/store";
import type { SpendEvent } from "@/keeper/sources/types";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runSpends } from "@/keeper/jobs/spends";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const VAULT = A(0xc2);
const UNIT = 1_000_000n;
const NOW = 1_800_000_000n;
const WEEK = NOW / 604_800n;
const GAS_PER_ACCRUE = 57_500n;

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let ctx: Ctx;
let sent: Address[];
let latencyMs = 0;
let accounts: Map<string, { settings: { roundTo: number; multiplier: number; weeklyCap: bigint }; account: { available: bigint; week: bigint; accruedThisWeek: bigint } }>;

/** n rows for `user`, row i spending `cents(i)`. */
async function importRows(user: Address, n: number, cents: (i: number) => bigint) {
  const rows = Array.from({ length: n }, (_, i) => {
    const id = keccak256(toHex(`${user}-${i}-${cents(i)}`)).slice(2);
    return { rowHash: id, event: { id, amountCents: cents(i), currency: "USD", at: new Date(), merchant: "x" } as SpendEvent };
  });
  await upsertSource({ db: t.db, chainId: 31337 }, user, "statement", "statement");
  await insertEvents({ db: t.db, chainId: 31337 }, user, "statement", "statement", rows);
}
const fund = (u: Address, available: bigint, roundTo = 1) =>
  accounts.set(u.toLowerCase(), { settings: { roundTo, multiplier: 1, weeklyCap: 1_000_000n * UNIT }, account: { available, week: WEEK, accruedThisWeek: 0n } });

beforeAll(async () => {
  t = await keeperTestDb("spendssybil");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from roundup_events" as never);
  await t.db.execute("delete from roundup_sources" as never);
  sent = [];
  latencyMs = 0;
  accounts = new Map();
  const view = (u: string) => accounts.get(u.toLowerCase()) ?? { settings: { roundTo: 0, multiplier: 0, weeklyCap: 0n }, account: { available: 0n, week: 0n, accruedThisWeek: 0n } };
  ctx = {
    chainId: 31337,
    db: t.db,
    account: A(0xaa),
    dep: { vault: VAULT } as unknown as KeeperDeployment,
    log: () => {},
    pub: {
      getBlock: async () => ({ timestamp: NOW }),
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "unit") return UNIT;
        if (functionName === "settingsOf") return view(String(args![0])).settings;
        if (functionName === "accountOf") return view(String(args![0])).account;
        throw new Error(`unexpected read ${functionName}`);
      },
      simulateContract: async () => ({ result: 0n }),
    },
    sender: {
      address: A(0xaa),
      sendCall: async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[]) => {
        if (fn !== "accrue") throw new Error(fn);
        const user = args[0] as Address;
        sent.push(user);
        const v = view(user);
        const r = roundUpOf(args[3] as bigint, v.settings.roundTo, v.settings.multiplier, UNIT);
        const room = v.settings.weeklyCap - v.account.accruedThisWeek;
        let added = r < room ? r : room;
        if (added > v.account.available) added = v.account.available;
        v.account.available -= added;
        v.account.accruedThisWeek += added;
        if (latencyMs) await Bun.sleep(latencyMs);
        return { transactionHash: keccak256(toHex(`tx-${sent.length}`)), blockNumber: 1n, status: "success", gasUsed: GAS_PER_ACCRUE, logs: [] };
      },
    },
  } as unknown as Ctx;
});

describe("V2-M5: sybils with 1 USDG each cannot buy keeper transactions", () => {
  test("20 sybils x 1 USDG, 100 rows of $x.99 each (1-cent round-ups): the keeper sends nothing in 3 passes", async () => {
    const SYB = Array.from({ length: 20 }, (_, i) => A(0xb000 + i));
    for (const u of SYB) {
      fund(u, 1n * UNIT);
      await importRows(u, 100, (i) => 99n + BigInt(i) * 100n);
    }
    for (let p = 0; p < 3; p++) await runSpends(ctx);
    expect(sent.length).toBeLessThan(200);
    expect(sent).toHaveLength(0);
    const [r] = (await t.sql`select count(*)::int as n from roundup_events where status = 'skipped' and reason like 'round-up below the keeper minimum%'`) as unknown as { n: number }[];
    expect(r!.n).toBe(2000);
  });

  test("sybils choosing $x.01 rows (99-cent round-ups) get at most 2 transactions per USDG locked, then the balance is used", async () => {
    const SYB = Array.from({ length: 20 }, (_, i) => A(0xc000 + i));
    for (const u of SYB) {
      fund(u, 1n * UNIT);
      await importRows(u, 100, (i) => 1n + BigInt(i) * 100n);
    }
    for (let p = 0; p < 3; p++) await runSpends(ctx);
    expect(sent.length).toBeLessThanOrEqual(2 * SYB.length);
  });

  test("an honest saver's round-ups of 25 cents and more still accrue; smaller ones are skipped with the reason", async () => {
    const SAVER = A(0x5a7e);
    fund(SAVER, 100n * UNIT);
    await importRows(SAVER, 4, (i) => [1_075n, 1_076n, 1_001n, 1_050n][i]!); // round-ups 25, 24, 99, 50 cents
    await runSpends(ctx);
    expect(sent).toHaveLength(3);
    const rows = (await t.sql`select status, reason from roundup_events order by status`) as unknown as { status: string; reason: string | null }[];
    expect(rows.filter((r) => r.status === "skipped").map((r) => r.reason)).toEqual(["round-up below the keeper minimum of 25 cents per accrual"]);
  });

  test("per user per pass: one user cannot take the whole pass; other users still accrue in the same pass", async () => {
    const BIG = A(0xd001);
    const SMALL = A(0xd002);
    fund(BIG, 1_000n * UNIT);
    fund(SMALL, 1_000n * UNIT);
    await importRows(BIG, 50, (i) => 1_001n + BigInt(i) * 100n);
    await importRows(SMALL, 3, (i) => 2_001n + BigInt(i) * 100n);
    await runSpends(ctx, new AccrueGate(ctx, { perUserPass: 5 }));
    expect(sent.filter((u) => u.toLowerCase() === BIG)).toHaveLength(5);
    expect(sent.filter((u) => u.toLowerCase() === SMALL)).toHaveLength(3);
  });

  test("wall-clock budget: a slow pass stops sending and leaves the rest open for the next pass", async () => {
    latencyMs = 20;
    const SYB = Array.from({ length: 10 }, (_, i) => A(0xe000 + i));
    for (const u of SYB) {
      fund(u, 1_000n * UNIT);
      await importRows(u, 10, (i) => 1_001n + BigInt(i) * 100n);
    }
    const t0 = performance.now();
    const r = await runSpends(ctx, new AccrueGate(ctx, { passMs: 100 }));
    expect(performance.now() - t0).toBeLessThan(400);
    expect(sent.length).toBeLessThan(10);
    expect(r.notes.join(" ")).toContain("time budget");
    const [open] = (await t.sql`select count(*)::int as n from roundup_events where status = 'new'`) as unknown as { n: number }[];
    expect(open!.n).toBe(100 - sent.length);
  });

  test("gas budget: the pass stops once its accruals used the budget", async () => {
    const SYB = Array.from({ length: 10 }, (_, i) => A(0xf000 + i));
    for (const u of SYB) {
      fund(u, 1_000n * UNIT);
      await importRows(u, 10, (i) => 1_001n + BigInt(i) * 100n);
    }
    const r = await runSpends(ctx, new AccrueGate(ctx, { passGas: GAS_PER_ACCRUE * 7n }));
    expect(sent).toHaveLength(7);
    expect(r.notes.join(" ")).toContain("gas budget");
  });
});

describe("H-1: keeper job order", () => {
  test("JOBS run in exactly the reviewed order; spends is last, liquidate (when present) right after the feed refresh", async () => {
    const { JOBS } = await import("@/keeper/keeper");
    // liquidate ships with the perps keeper job (audit-contracts). Once its file exists it must be in JOBS, second.
    const hasLiquidate = existsSync(join(import.meta.dir, "liquidate.ts"));
    const order = ["refresh-mock-feeds", "liquidate", "fee-push", "topups", "roundups", "sweep", "beacon", "execute", "deliver-quiet", "deliver-hidden", "spends"];
    expect(JOBS.map(([n]) => n)).toEqual(hasLiquidate ? order : order.filter((n) => n !== "liquidate"));
  });
});
