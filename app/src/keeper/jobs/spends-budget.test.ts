// Audit M-7: any new wallet can sign a statement import of thousands of rows. vault.accrue never reverts for a user it
// cannot credit (it adds 0), so before the fix the keeper sent one accrue per row for a wallet with no account at
// all: the PoC was a zero-ETH wallet triggering 150 keeper transactions that all added 0. Now nothing is sent for a
// user the vault cannot credit, and accruals are capped per user per week and per pass.
// Real Postgres (roundup_sources / roundup_events) + a fake vault and a counting sender.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { keccak256, toHex, type Address } from "viem";
import type { Ctx, KeeperDeployment } from "@/keeper/context";
import { AccrueGate, roundUpOf } from "@/keeper/sources/accrue";
import { insertEvents, upsertSource } from "@/keeper/sources/store";
import type { SpendEvent } from "@/keeper/sources/types";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runSpends } from "./spends";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const VAULT = A(0xc2);
const ATTACKER = A(0x0bad); // a fresh wallet: never set up savings, never deposited
const SAVER = A(0x5a7e);
const UNIT = 1_000_000n;
const NOW = 1_800_000_000n; // chain time
const WEEK = NOW / 604_800n;

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let ctx: Ctx;
let sent: Address[];
let accounts: Map<string, { settings: { roundTo: number; multiplier: number; weeklyCap: bigint }; account: { available: bigint; week: bigint; accruedThisWeek: bigint } }>;

/** n spends of $x.37 each (each has a round-up of 63 cents at roundTo 1), dated now. */
const spends = (n: number, tag: string): { rowHash: string; event: SpendEvent }[] =>
  Array.from({ length: n }, (_, i) => {
    const id = keccak256(toHex(`${tag}-${i}`)).slice(2);
    return { rowHash: id, event: { id, amountCents: 1_037n + BigInt(i) * 100n, currency: "USD", at: new Date(), merchant: "junk" } };
  });

async function importRows(user: Address, rows: { rowHash: string; event: SpendEvent }[]) {
  await upsertSource({ db: t.db, chainId: 31337 }, user, "statement", "statement");
  await insertEvents({ db: t.db, chainId: 31337 }, user, "statement", "statement", rows);
}

const statusOf = async (user: Address) =>
  (await t.sql`select status, reason, count(*)::int as n from roundup_events where user_address = ${user.toLowerCase()} group by 1, 2 order by 1, 2`) as unknown as { status: string; reason: string | null; n: number }[];

beforeAll(async () => {
  t = await keeperTestDb("spendsbudget");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from roundup_events" as never);
  await t.db.execute("delete from roundup_sources" as never);
  sent = [];
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
      simulateContract: async () => ({ result: 0n }), // accrue never reverts for these users: that is the bug class
    },
    sender: {
      address: A(0xaa),
      sendCall: async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[]) => {
        if (fn !== "accrue") throw new Error(fn);
        const user = args[0] as Address;
        sent.push(user);
        // the vault's arithmetic, so the gate's own tracking is exercised
        const v = view(user);
        const r = roundUpOf(args[3] as bigint, v.settings.roundTo, v.settings.multiplier, UNIT);
        const room = v.settings.weeklyCap - v.account.accruedThisWeek;
        let added = r < room ? r : room;
        if (added > v.account.available) added = v.account.available;
        v.account.available -= added;
        v.account.accruedThisWeek += added;
        return { transactionHash: keccak256(toHex(`tx-${sent.length}`)), blockNumber: 1n, status: "success", logs: [] };
      },
    },
  } as unknown as Ctx;
});

describe("M-7: statement imports cannot make the keeper pay for junk accruals", () => {
  test("PoC: a fresh wallet imports 150 rows -> no keeper transaction at all; rows skipped with the reason", async () => {
    await importRows(ATTACKER, spends(150, "junk"));
    for (let i = 0; i < 3; i++) await runSpends(ctx);
    expect(sent).toHaveLength(0);
    expect(await statusOf(ATTACKER)).toEqual([{ status: "skipped", reason: "no savings settings: the vault would add 0", n: 150 }]);
  });

  test("set up but nothing available: still nothing sent", async () => {
    accounts.set(ATTACKER.toLowerCase(), { settings: { roundTo: 1, multiplier: 1, weeklyCap: 500n * UNIT }, account: { available: 0n, week: WEEK, accruedThisWeek: 0n } });
    await importRows(ATTACKER, spends(40, "junk2"));
    await runSpends(ctx);
    expect(sent).toHaveLength(0);
    expect((await statusOf(ATTACKER))[0]!.reason).toMatch(/no available balance/);
  });

  test("a funded saver accrues until the weekly cap is used, then the rest is skipped without a transaction", async () => {
    // cap 2 USDG, each spend rounds up 0.63: 4 accruals use it (the 4th is clipped), the other 16 would add 0
    accounts.set(SAVER.toLowerCase(), { settings: { roundTo: 1, multiplier: 1, weeklyCap: 2n * UNIT }, account: { available: 100n * UNIT, week: WEEK, accruedThisWeek: 0n } });
    await importRows(SAVER, spends(20, "real"));
    await runSpends(ctx);
    expect(sent).toHaveLength(4);
    expect(accounts.get(SAVER.toLowerCase())!.account.accruedThisWeek).toBe(2n * UNIT);
    const rows = await statusOf(SAVER);
    expect(rows.find((r) => r.status === "done")!.n).toBe(4);
    expect(rows.find((r) => r.status === "skipped")).toMatchObject({ reason: "weekly cap reached: the vault would add 0", n: 16 });
  });

  test("whole-amount spends (round-up 0) are skipped, not sent", async () => {
    accounts.set(SAVER.toLowerCase(), { settings: { roundTo: 1, multiplier: 1, weeklyCap: 500n * UNIT }, account: { available: 100n * UNIT, week: WEEK, accruedThisWeek: 0n } });
    const whole = spends(5, "whole").map((r, i) => ({ ...r, event: { ...r.event, amountCents: BigInt(i + 1) * 100n } }));
    await importRows(SAVER, whole);
    await runSpends(ctx);
    expect(sent).toHaveLength(0);
    expect((await statusOf(SAVER))[0]).toMatchObject({ status: "skipped", n: 5 });
  });

  test("per user per week and per pass limits", async () => {
    accounts.set(SAVER.toLowerCase(), { settings: { roundTo: 10, multiplier: 3, weeklyCap: 500n * UNIT }, account: { available: 10_000n * UNIT, week: WEEK, accruedThisWeek: 0n } });
    await importRows(SAVER, spends(30, "many"));
    // per pass: 5 per pass, the rest stays open for later passes
    let r = await runSpends(ctx, new AccrueGate(ctx, { perPass: 5, perUserWeek: 12 }));
    expect(sent).toHaveLength(5);
    expect(r.notes.join(" ")).toContain("pass budget");
    expect((await statusOf(SAVER)).find((x) => x.status === "new")!.n).toBe(25);
    // per user per week: 12 in total this week, counted from the rows the keeper already sent
    for (let i = 0; i < 4; i++) r = await runSpends(ctx, new AccrueGate(ctx, { perPass: 5, perUserWeek: 12 }));
    expect(sent).toHaveLength(12);
    expect((await statusOf(SAVER)).find((x) => x.status === "skipped")).toMatchObject({ reason: "weekly limit of 12 accruals for this user reached", n: 18 });
  });

  test("the keeper's pass runs spends after every core job", async () => {
    const { JOBS } = await import("@/keeper/keeper");
    const names = JOBS.map(([n]) => n);
    for (const core of ["sweep", "beacon", "execute", "deliver-quiet", "deliver-hidden"]) expect(names.indexOf("spends")).toBeGreaterThan(names.indexOf(core));
  });
});
