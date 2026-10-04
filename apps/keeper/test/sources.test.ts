// Todo 23: round-up sources. Parsers (S1-S5) on fixtures of three bank CSV layouts plus OFX (SGML/QFX and
// XML), the Plaid adapter (P1-P5) mocked at HTTP level with msw, dedupe in Postgres, accrual keys.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { encodeAbiParameters, getAddress, keccak256, type Address } from "viem";
import { Sealer } from "../src/seal";
import {
  accrualKey,
  activeSources,
  insertEvents,
  openEvents,
  parseCents,
  parseCsv,
  parseDate,
  parseStatement,
  plaidAad,
  plaidEvent,
  plaidFromEnv,
  plaidRowHash,
  PlaidSource,
  sha256Hex,
  spendRows,
  StatementError,
  StatementSource,
  syncItem,
  unlinkSource,
  upsertSource,
  usdgUnits,
  type ParsedStatement,
} from "../src/sources";
import { LOOKBACK_DAYS, rowHashOf, sinceFor } from "../src/jobs/spends";
import { keeperTestDb } from "./helpers";

const fx = (f: string) => readFileSync(join(import.meta.dir, "fixtures", f), "utf8");
const spends = (p: ParsedStatement) => p.rows.filter((r) => r.event).map((r) => r.event!.amountCents);
const skips = (p: ParsedStatement) => p.rows.filter((r) => r.skip).map((r) => r.skip);
const U1 = getAddress("0x00000000000000000000000000000000000000a1");
const U2 = getAddress("0x00000000000000000000000000000000000000a2");

describe("statement parsing", () => {
  test("S1+S2 chase: header detected, negative amounts are spends, credits/returns skipped", () => {
    const p = parseStatement(fx("chase.csv"));
    expect(p).toMatchObject({ format: "csv", layout: "chase" });
    expect(spends(p)).toEqual([435n, 435n, 5210n, 275n]);
    expect(skips(p)).toEqual(["credit, not a spend", "credit, not a spend", "unreadable amount"]);
    const e = p.rows[2]!.event!;
    expect(e).toMatchObject({ currency: "USD", merchant: "GROCER, INC" });
    expect(e.at.toISOString()).toBe("2026-09-27T00:00:00.000Z");
  });

  test("S1 bank of america: the summary preamble is ignored, header found below it", () => {
    const p = parseStatement(fx("bankofamerica.csv"));
    expect(p.layout).toBe("bankofamerica");
    expect(spends(p)).toEqual([840n, 122616n]);
    expect(skips(p)).toEqual(["no amount", "credit, not a spend"]);
    expect(p.rows[0]!.line).toBe(8);
  });

  test("S2 capital one: Debit column is the spend, Credit column is skipped", () => {
    const p = parseStatement(fx("capitalone.csv"));
    expect(p.layout).toBe("capitalone");
    expect(spends(p)).toEqual([650n, 1999n, 700n]);
    expect(skips(p)).toEqual(["credit, not a spend"]);
  });

  test("S2 debitSign=positive flips a single Amount column (card exports with charges positive)", () => {
    const csv = "Date,Description,Amount\n2026-09-01,Shop,12.34\n2026-09-02,Refund,-5.00\n";
    expect(spends(parseStatement(csv))).toEqual([500n]); // default: negative is the spend
    const p = parseStatement(csv, { debitSign: "positive" });
    expect(p.layout).toBe("generic/positive");
    expect(spends(p)).toEqual([1234n]);
    expect(skips(p)).toEqual(["credit, not a spend"]);
  });

  test("S3 non-USD rows are skipped with a reason; an empty currency cell means USD", () => {
    const p = parseStatement(fx("generic-currency.csv"));
    expect(spends(p)).toEqual([320n, 100n]);
    expect(skips(p)).toEqual(["currency EUR is not USD"]);
  });

  test("S3 unreadable dates and zero amounts are skipped; an unknown layout is refused", () => {
    const p = parseStatement("Date,Description,Amount\n02/30/2026,Bad date,-1.00\n2026-09-01,Nothing,0.00\n");
    expect(skips(p)).toEqual(["unreadable date", "zero amount"]);
    expect(() => parseStatement("foo,bar\n1,2\n")).toThrow(StatementError);
    expect(() => parseStatement('Date,Description,Amount\n2026-09-01,"unterminated,-1\n')).toThrow(StatementError);
  });

  test("S4 identical rows in one file get distinct hashes; re-parsing gives the same hashes", () => {
    const a = parseStatement(fx("chase.csv"));
    const b = parseStatement(fx("chase.csv"));
    expect(a.rows[0]!.rowHash).not.toBe(a.rows[1]!.rowHash);
    expect(a.rows.map((r) => r.rowHash)).toEqual(b.rows.map((r) => r.rowHash));
    expect(new Set(a.rows.map((r) => r.rowHash)).size).toBe(a.rows.length);
    // whitespace around cells does not change the identity
    const c = parseStatement(fx("chase.csv").replace("BLUE BOTTLE COFFEE,Food", " BLUE BOTTLE COFFEE ,Food"));
    expect(c.rows[0]!.rowHash).toBe(a.rows[0]!.rowHash);
  });

  test("S5 OFX SGML (QFX): negative TRNAMT is a spend, CURRENCY aggregate decides the currency, FITID is identity", () => {
    const p = parseStatement(fx("bank.qfx"));
    expect(p).toMatchObject({ format: "ofx", layout: "ofx" });
    expect(spends(p)).toEqual([2345n, 999n]);
    expect(skips(p)).toEqual(["credit, not a spend", "currency EUR is not USD"]);
    expect(p.rows[0]!.event!.merchant).toBe("HARDWARE STORE");
    expect(p.rows[0]!.event!.at.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    // FITID identity: changing the memo does not change the row hash
    expect(parseStatement(fx("bank.qfx").replace("POS PURCHASE", "OTHER")).rows[0]!.rowHash).toBe(p.rows[0]!.rowHash);
  });

  test("S5 OFX XML credit card statement (CCSTMTRS): charges negative, refunds skipped, entities decoded", () => {
    const p = parseStatement(fx("card.ofx"));
    expect(spends(p)).toEqual([3107n, 110n]);
    expect(skips(p)).toEqual(["credit, not a spend"]);
    expect(p.rows[0]!.event!.merchant).toBe("BISTRO & BAR");
  });

  test("statement size cap", () => {
    expect(() => parseStatement("x".repeat(2_000_001))).toThrow(/larger than/);
  });
});

describe("amount, date and CSV primitives", () => {
  test("parseCents accepts bank notations and rejects sub-cent or junk", () => {
    expect(parseCents("$1,234.56")).toBe(123456n);
    expect(parseCents("(12.34)")).toBe(-1234n);
    expect(parseCents("12.34-")).toBe(-1234n);
    expect(parseCents("-0.5")).toBe(-50n);
    expect(parseCents("+7")).toBe(700n);
    for (const bad of ["", "1.234", "1e3", "abc", "--1", "1.2.3"]) expect(parseCents(bad)).toBeNull();
  });

  test("fuzz: parseCents round-trips random cents in every notation", () => {
    for (let i = 0; i < 3000; i++) {
      const c = BigInt(Math.floor(Math.random() * 1e11));
      const s = `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
      const grouped = `${(c / 100n).toLocaleString("en-US")}.${(c % 100n).toString().padStart(2, "0")}`;
      expect(parseCents(s)).toBe(c);
      expect(parseCents(`-$${grouped}`)).toBe(-c);
      expect(parseCents(`(${s})`)).toBe(-c);
    }
  });

  test("parseDate: US, ISO and OFX forms; impossible dates are null", () => {
    expect(parseDate("9/5/26")!.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(parseDate("2026-09-05")!.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(parseDate("20260905")!.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(parseDate("02/29/2027")).toBeNull();
    expect(parseDate("13/01/2026")).toBeNull();
  });

  test("parseCsv: quotes, doubled quotes, embedded newlines, CRLF and BOM", () => {
    const rows = parseCsv('﻿a,"b,c","say ""hi"""\r\n1,"two\nlines",3\r\n');
    expect(rows.map((r) => r.cells)).toEqual([["a", "b,c", 'say "hi"'], ["1", "two\nlines", "3"]]);
    expect(rows.map((r) => r.line)).toEqual([1, 2]);
  });
});

describe("accrual keys and units", () => {
  test("accrualKey = keccak256(abi.encode(source, user, id)); differs per user, source and id", () => {
    const k = accrualKey("statement", U1, "abc");
    expect(k).toBe(keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "string" }], ["statement", U1, "abc"])));
    expect(accrualKey("statement", U2, "abc")).not.toBe(k);
    expect(accrualKey("plaid", U1, "abc")).not.toBe(k);
    expect(accrualKey("statement", U1, "abd")).not.toBe(k);
    expect(accrualKey("statement", getAddress(U1).toLowerCase() as Address, "abc")).toBe(k);
  });

  test("usdgUnits: 1 cent = 10_000 USDG base units; exact units win", () => {
    expect(usdgUnits({ amountCents: 435n })).toBe(4_350_000n);
    expect(usdgUnits({ amountCents: 0n, units: 1_234_567n })).toBe(1_234_567n);
  });

  test("lookback: events from 30 days before linking count; row hash per source", () => {
    const linked = new Date("2026-10-04T00:00:00Z");
    expect(sinceFor(linked).toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(LOOKBACK_DAYS).toBe(30);
    expect(rowHashOf("statement", "ab")).toBe("ab");
    expect(rowHashOf("plaid", "tx1")).toBe(plaidRowHash("tx1"));
  });
});

// ---------------------------------------------------------------- Plaid

type Tx = Record<string, unknown>;
const ptx = (id: string, amount: number, extra: Tx = {}): Tx => ({
  transaction_id: id,
  account_id: "acc",
  amount,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  date: "2026-09-20",
  authorized_date: null,
  pending: false,
  merchant_name: "Shop",
  name: "SHOP 123",
  ...extra,
});

describe("plaidEvent rules", () => {
  test("P1 positive amount is a spend; negative (refund/deposit) and zero are skipped", () => {
    expect(plaidEvent(ptx("a", 12.3) as any).event).toMatchObject({ id: "a", amountCents: 1230n, currency: "USD", merchant: "Shop" });
    expect(plaidEvent(ptx("b", -12.3) as any).skip).toBe("credit, not a spend");
    expect(plaidEvent(ptx("c", 0) as any).skip).toBe("zero amount");
    expect(plaidEvent(ptx("d", 0.1 + 0.2) as any).event!.amountCents).toBe(30n); // float noise rounds to cents
  });
  test("P2 pending is skipped; P3 non-USD and unknown currency are skipped", () => {
    expect(plaidEvent(ptx("a", 5, { pending: true }) as any).skip).toMatch(/pending/);
    expect(plaidEvent(ptx("a", 5, { iso_currency_code: "CAD" }) as any).skip).toBe("currency CAD is not USD");
    expect(plaidEvent(ptx("a", 5, { iso_currency_code: null, unofficial_currency_code: "BTC" }) as any).skip).toBe("currency BTC is not USD");
    expect(plaidEvent(ptx("a", 5, { iso_currency_code: null }) as any).skip).toBe("currency unknown is not USD");
  });
  test("authorized_date wins over date", () => {
    expect(plaidEvent(ptx("a", 5, { authorized_date: "2026-09-18" }) as any).event!.at.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });
});

describe("plaidFromEnv", () => {
  test("disabled without credentials; sandbox by default; production switch; bad env refused", () => {
    expect(plaidFromEnv({})).toBeUndefined();
    expect(plaidFromEnv({ PLAID_CLIENT_ID: "x" })).toBeUndefined();
    const sb = plaidFromEnv({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y" })!;
    expect(sb.env).toBe("sandbox");
    expect((sb.api as any).configuration.basePath).toBe(PlaidEnvironments.sandbox);
    const prod = plaidFromEnv({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y", PLAID_ENV: "production", PLAID_COUNTRY_CODES: "us, gb" })!;
    expect((prod.api as any).configuration.basePath).toBe(PlaidEnvironments.production);
    expect(prod.countryCodes).toEqual(["US", "GB"]);
    expect(() => plaidFromEnv({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y", PLAID_ENV: "development" })).toThrow(/sandbox or production/);
  });
});

// Plaid Sandbox mocked at HTTP level: a tiny stateful /transactions/sync.
type Page = { added?: Tx[]; modified?: Tx[]; removed?: string[]; next: string; more: boolean };
let pages: Map<string, Page | "mutation">;
const calls: { path: string; body: any; headers: Record<string, string> }[] = [];
const server = setupServer(
  http.post(`${PlaidEnvironments.sandbox}/transactions/sync`, async ({ request }) => {
    const body = (await request.json()) as any;
    calls.push({ path: "/transactions/sync", body, headers: Object.fromEntries(request.headers) });
    if (body.access_token !== "access-sandbox-1") return HttpResponse.json({ error_code: "INVALID_ACCESS_TOKEN", error_type: "INVALID_INPUT" }, { status: 400 });
    const p = pages.get(body.cursor ?? "");
    if (p === "mutation") {
      pages.delete(body.cursor ?? ""); // next time it succeeds
      return HttpResponse.json({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_type: "TRANSACTIONS_ERROR" }, { status: 400 });
    }
    if (!p) return HttpResponse.json({ added: [], modified: [], removed: [], next_cursor: body.cursor ?? "", has_more: false });
    return HttpResponse.json({ added: p.added ?? [], modified: p.modified ?? [], removed: (p.removed ?? []).map((transaction_id) => ({ transaction_id })), next_cursor: p.next, has_more: p.more });
  }),
);
const plaid = new PlaidApi(new Configuration({ basePath: PlaidEnvironments.sandbox, baseOptions: { headers: { "PLAID-CLIENT-ID": "client-test", "PLAID-SECRET": "secret-test" } } }));

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  calls.length = 0;
});
afterAll(() => server.close());

describe("syncItem (P4) against mocked Plaid", () => {
  test("pages until has_more is false and returns the last cursor; credentials sent as headers", async () => {
    pages = new Map<string, Page | "mutation">([
      ["", { added: [ptx("t1", 4.35), ptx("t2", -20)], next: "c1", more: true }],
      ["c1", { added: [ptx("t3", 2.75, { pending: true })], modified: [ptx("t4", 1.01)], removed: ["t0"], next: "c2", more: false }],
    ]);
    const r = await syncItem(plaid, "access-sandbox-1", undefined);
    expect(r.cursor).toBe("c2");
    expect(r.upserts.map((u) => [u.event.id, u.event.amountCents])).toEqual([["t1", 435n], ["t4", 101n]]);
    expect(r.upserts[0]!.rowHash).toBe(plaidRowHash("t1"));
    expect(r.skipped.map((s) => s.id)).toEqual(["t2", "t3"]);
    expect(r.removed).toEqual(["t0"]);
    expect(calls[0]!.headers["plaid-client-id"]).toBe("client-test");
    expect(calls[0]!.body.cursor).toBeUndefined();
    expect(calls[1]!.body.cursor).toBe("c1");
  });

  test("a mutation during pagination restarts from the starting cursor", async () => {
    pages = new Map<string, Page | "mutation">([
      ["s", { added: [ptx("m1", 3)], next: "s1", more: true }],
      ["s1", "mutation"],
    ]);
    const r = await syncItem(plaid, "access-sandbox-1", "s");
    expect(calls.map((c) => c.body.cursor)).toEqual(["s", "s1", "s", "s1"]);
    expect(r.upserts.map((u) => u.event.id)).toEqual(["m1"]); // restarted cleanly, no duplicates
    expect(r.cursor).toBe("s1");
  });

  test("other Plaid errors propagate", async () => {
    pages = new Map();
    await expect(syncItem(plaid, "wrong-token", undefined)).rejects.toThrow();
  });
});

describe("store + sources in Postgres", () => {
  let t: Awaited<ReturnType<typeof keeperTestDb>>;
  let sealer: Sealer;
  const b = () => ({ db: t.db, chainId: 31337 });
  beforeAll(async () => {
    t = await keeperTestDb("sources");
    sealer = await Sealer.create(crypto.getRandomValues(new Uint8Array(32)));
  });
  afterAll(async () => {
    await t?.drop();
  });

  test("dedupe: re-importing the same statement inserts nothing; another user's identical rows are separate", async () => {
    const rows = spendRows(parseStatement(fx("chase.csv")).rows);
    expect(await insertEvents(b(), U1, "statement", "statement", rows)).toEqual({ inserted: 4, duplicates: 0 });
    expect(await insertEvents(b(), U1, "statement", "statement", rows)).toEqual({ inserted: 0, duplicates: 4 });
    // overlapping statement: two new rows plus two already imported
    const more = spendRows(parseStatement(fx("chase.csv") + "09/29/2026,09/30/2026,NEWSSTAND,Misc,Sale,-1.25,\n").rows);
    expect(await insertEvents(b(), U1, "statement", "statement", more)).toEqual({ inserted: 1, duplicates: 4 });
    expect(await insertEvents(b(), U2, "statement", "statement", rows)).toEqual({ inserted: 4, duplicates: 0 });
    const n = await t.sql`select user_address, count(*)::int as n from roundup_events group by 1 order by 1`;
    expect(n.map((r) => r.n)).toEqual([5, 4]);
  });

  test("StatementSource.fetch returns open events since a date, oldest first", async () => {
    const ev = await new StatementSource(b()).fetch(U1, new Date("2026-09-25T00:00:00Z"));
    expect(ev.map((e) => e.amountCents)).toEqual([5210n, 435n, 435n, 125n]);
    expect(ev.every((e) => e.id.length === 64)).toBe(true);
  });

  test("link/unlink: unlink forgets the sealed secret and the source is no longer active", async () => {
    await upsertSource(b(), U1, "plaid", "item-x", "v1.sealed");
    expect((await activeSources(b(), "plaid", U1)).map((s) => s.sourceKey)).toEqual(["item-x"]);
    const before = await unlinkSource(b(), U1, "plaid", "item-x");
    expect(before?.secretEnc).toBe("v1.sealed");
    expect(await activeSources(b(), "plaid", U1)).toEqual([]);
    const [row] = await t.sql`select status, secret_enc from roundup_sources where source_key = 'item-x'`;
    expect(row).toEqual({ status: "unlinked", secret_enc: null });
  });

  test("PlaidSource (P4, P5): syncs from the stored cursor, stores events, persists the cursor, skips removed", async () => {
    const sealed = await sealer.seal(new TextEncoder().encode("access-sandbox-1"), plaidAad(31337, U2, "item-1"));
    await upsertSource(b(), U2, "plaid", "item-1", sealed);
    pages = new Map<string, Page | "mutation">([["", { added: [ptx("p1", 12.3), ptx("p2", 7.8), ptx("p3", -1)], next: "k1", more: false }]]);
    const src = new PlaidSource({ ...b(), sealer, plaid });
    const ev = await src.fetch(U2, new Date("2026-09-01T00:00:00Z"));
    expect(ev.map((e) => [e.id, e.amountCents])).toEqual([["p1", 1230n], ["p2", 780n]]);
    expect(src.errors.size).toBe(0);
    const [s] = await t.sql`select cursor, last_synced_at, secret_enc from roundup_sources where source_key = 'item-1'`;
    expect(s!.cursor).toBe("k1");
    expect(s!.last_synced_at).not.toBeNull();
    expect(String(s!.secret_enc)).not.toContain("access-sandbox"); // sealed at rest

    // next sync from k1: p2 removed by the bank, p1 modified (amount changed while still open)
    pages.set("k1", { modified: [ptx("p1", 12.4)], removed: ["p2"], next: "k2", more: false });
    const ev2 = await src.fetch(U2, new Date("2026-09-01T00:00:00Z"));
    expect(ev2.map((e) => [e.id, e.amountCents])).toEqual([["p1", 1240n]]);
    const [p2] = await t.sql`select status, reason from roundup_events where row_hash = ${plaidRowHash("p2")}`;
    expect(p2).toEqual({ status: "skipped", reason: "removed by the bank" });
    expect(calls.at(-1)!.body.cursor).toBe("k1");
  });

  test("a sealed token for another user or item does not open: the item records an error, nothing syncs", async () => {
    const wrong = await sealer.seal(new TextEncoder().encode("access-sandbox-1"), plaidAad(31337, U1, "item-2"));
    await upsertSource(b(), U2, "plaid", "item-2", wrong);
    const src = new PlaidSource({ ...b(), sealer, plaid });
    await src.fetch(U2, new Date(0));
    expect(src.errors.has("item-2")).toBe(true);
    const [row] = await t.sql`select last_error, cursor from roundup_sources where source_key = 'item-2'`;
    expect(row!.last_error).toBeTruthy();
    expect(row!.cursor).toBeNull();
    await unlinkSource(b(), U2, "plaid", "item-2");
  });

  test("open events skip finished and exhausted rows", async () => {
    await t.sql`update roundup_events set status = 'done' where user_address = ${U1.toLowerCase()} and amount_cents = 125`;
    await t.sql`update roundup_events set status = 'failed', attempts = 5 where user_address = ${U1.toLowerCase()} and amount_cents = 275`;
    const ev = await openEvents(b(), U1, "statement", new Date(0));
    expect(ev.map((e) => e.amountCents)).toEqual([5210n, 435n, 435n]);
  });

  test("sha256Hex is plain sha256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
