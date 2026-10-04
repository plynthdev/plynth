// Reconciler (todo 29): venue statement vs PositionMirror vs fill ledger. An injected break opens one
// exceptions row and one `reconcile.break` webhook, repeats hourly without new rows, blocks PeriodClose until a
// human explains it; transient kinds auto-resolve. Runs against memory stores and, when Postgres is up, the
// real tables in a throwaway plynth_t_* database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDatabaseIfMissing, databaseUrl, dropDatabase, runMigrations, withDatabase } from "@/db";
import { getAddress, type Address, type PublicClient } from "viem";
import { closeOnce, type CloseContext } from "@/treasury/close/service";
import { breakGate, MemoryExceptionStore, MemoryLedger, PgExceptionStore, PgLedger, Reconciler, type ExceptionStore, type FillLedger } from "./";
import { Webhooks } from "@/treasury/risk/webhooks";
import type { PerpVenueClient, VenueStatement } from "@/treasury/venues/types";

const E18 = 10n ** 18n;
const ACCT = getAddress("0x00000000000000000000000000000000000acc01");
const MIRROR = getAddress("0x00000000000000000000000000000000000f1220");
const ADAPTER = getAddress("0x0000000000000000000000000000000000000ad1");
const TSLA = getAddress("0x00000000000000000000000000000000000075a1");
const NVDA = getAddress("0x000000000000000000000000000000000000bda1");

class FakeVenue implements PerpVenueClient {
  readonly kind = "orderly" as const;
  fail = false;
  constructor(
    readonly name: string,
    public st: VenueStatement,
  ) {}
  async funding() {
    return [];
  }
  async statement() {
    if (this.fail) throw new Error("venue down");
    return this.st;
  }
  async placeOrder(): Promise<never> {
    throw new Error("unused");
  }
}

/** Only what the reconciler reads: PositionMirror.latest / isStale. */
function fakePub(m: { positions: { underlying: Address; tokens: bigint }[]; equity: bigint; stale: boolean }) {
  return {
    async readContract(a: { functionName: string }) {
      if (a.functionName === "latest") return [m.positions, m.equity, 0n, 1000n];
      if (a.functionName === "isStale") return m.stale;
      throw new Error(a.functionName);
    },
  } as unknown as PublicClient;
}

function hooksSink() {
  const got: { type: string; data: Record<string, unknown> }[] = [];
  const wh = new Webhooks({ urls: ["http://hooks.invalid/x"], retries: 0, fetchImpl: (async (_u: string, init: RequestInit) => { got.push(JSON.parse(String(init.body))); return new Response("ok"); }) as unknown as typeof fetch });
  return { wh, got };
}

async function scenario(store: ExceptionStore, ledger: FillLedger) {
  const venue = new FakeVenue("orderly:0xabc", { venue: "orderly:0xabc", ts: 0, positions: [{ underlying: TSLA, tokens: -10n * E18 }], equityUsd: 5_000n * E18 });
  const mirror = { positions: [{ underlying: TSLA, tokens: -10n * E18 }], equity: 4_990n * E18, stale: false };
  await ledger.record(1, ACCT, { venue: venue.name, underlying: TSLA, desk: "hedge", tokens: -6n * E18 });
  await ledger.record(1, ACCT, { venue: venue.name, underlying: TSLA, desk: "hedge", tokens: -4n * E18 });
  const { wh, got } = hooksSink();
  const rec = new Reconciler(fakePub(mirror), { chainId: 1, account: ACCT, mirror: MIRROR, venues: [{ client: venue, mode: "mirrored", adapter: ADAPTER }] }, { store, ledger, webhooks: wh });
  return { venue, mirror, rec, got };
}

function suite(name: string, make: () => Promise<{ store: ExceptionStore; ledger: FillLedger }>) {
  describe(name, () => {
    test("all three sources agree: no break; equity inside tolerance (mirror lags one push)", async () => {
      const { store, ledger } = await make();
      const { rec, got } = await scenario(store, ledger);
      const r = await rec.run();
      expect(r.breaks).toEqual([]);
      expect(got).toEqual([]);
      expect(await breakGate(store, 1, ACCT).count()).toBe(0);
    });

    test("an injected break (venue shows a position the ledger never filled) is caught once, blocks the close, and clears only with an explanation", async () => {
      const { store, ledger } = await make();
      const { venue, mirror, rec, got } = await scenario(store, ledger);
      // Somebody traded NVDA at the venue outside the desks: venue + mirror show it, the ledger does not.
      venue.st = { ...venue.st, positions: [...venue.st.positions, { underlying: NVDA, tokens: 3n * E18 }] };
      mirror.positions = [...mirror.positions, { underlying: NVDA, tokens: 3n * E18 }];
      const r1 = await rec.run();
      expect(r1.newBreaks).toHaveLength(1);
      expect(r1.newBreaks[0]).toMatchObject({ kind: "reconcile.position", underlying: NVDA, detail: { statement: 3n * E18, ledger: 0n, mirror: 3n * E18 } });
      expect(got.map((h) => h.type)).toEqual(["reconcile.break"]);
      expect(got[0]!.data).toMatchObject({ kind: "reconcile.position", underlying: NVDA, account: ACCT });

      const r2 = await rec.run(); // the next hour: same break, no new row, no new webhook
      expect(r2.breaks).toHaveLength(1);
      expect(r2.newBreaks).toHaveLength(0);
      expect(got).toHaveLength(1);
      const open = await store.open(1, ACCT);
      expect(open).toHaveLength(1);
      expect(await breakGate(store, 1, ACCT).count()).toBe(1);

      // A position break never auto-resolves, even if the sources agree again later.
      venue.st = { ...venue.st, positions: venue.st.positions.filter((p) => p.underlying !== NVDA) };
      mirror.positions = mirror.positions.filter((p) => p.underlying !== NVDA);
      expect((await rec.run()).resolved).toEqual([]);
      expect(await breakGate(store, 1, ACCT).count()).toBe(1);

      await expect(store.explain(open[0]!.id, " ", "kal")).rejects.toThrow();
      await store.explain(open[0]!.id, "manual NVDA test order on the venue UI, flattened at 14:05", "kal");
      expect(await breakGate(store, 1, ACCT).count()).toBe(0);
    });

    test("mirror vs statement: position and equity gaps, stale mirror (auto-resolves), venue errors", async () => {
      const { store, ledger } = await make();
      const { venue, mirror, rec } = await scenario(store, ledger);
      mirror.positions = [{ underlying: TSLA, tokens: -9n * E18 }];
      mirror.equity = 4_000n * E18;
      mirror.stale = true;
      const r = await rec.run();
      expect(r.breaks.map((b) => b.kind).sort()).toEqual(["reconcile.equity", "reconcile.position", "reconcile.stale_mirror"]);
      mirror.stale = false;
      const r2 = await rec.run();
      expect(r2.resolved).toHaveLength(1); // the stale-mirror row closed itself
      expect((await store.open(1, ACCT)).map((x) => x.kind).sort()).toEqual(["reconcile.equity", "reconcile.position"]);
      venue.fail = true;
      const r3 = await rec.run();
      expect(r3.newBreaks.map((b) => b.kind)).toEqual(["reconcile.venue_error"]);
    });

    test("in-house (on-chain) venue: statement vs ledger only", async () => {
      const { store, ledger } = await make();
      const v = new FakeVenue("0x00000000000000000000000000000000000000a7", { venue: "x", ts: 0, positions: [{ underlying: TSLA, tokens: -2n * E18 }], equityUsd: E18 });
      const rec = new Reconciler(null, { chainId: 1, account: ACCT, venues: [{ client: v, mode: "onchain" }] }, { store, ledger });
      expect((await rec.run()).breaks).toHaveLength(1);
      await ledger.record(1, ACCT, { venue: v.name, underlying: TSLA, desk: "basis", tokens: -2n * E18 });
      const s2 = new MemoryExceptionStore();
      expect((await new Reconciler(null, { chainId: 1, account: ACCT, venues: [{ client: v, mode: "onchain" }] }, { store: s2, ledger }).run()).breaks).toHaveLength(0);
    });
  });
}

suite("reconciler (memory stores)", async () => ({ store: new MemoryExceptionStore(), ledger: new MemoryLedger() }));

// Postgres: the same scenarios on the real tables (migration 0006) in a plynth_t_* database.
let pg: { url: string; conn: ReturnType<typeof connect> } | undefined;
beforeAll(async () => {
  try {
    const url = withDatabase(databaseUrl(), `plynth_t_reconcile_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
    await createDatabaseIfMissing(url);
    await runMigrations(url);
    pg = { url, conn: connect(url) };
  } catch {
    pg = undefined; // no Postgres here: the memory suite still covers the rules
  }
}, 60_000);
afterAll(async () => {
  if (!pg) return;
  await pg.conn.close();
  await dropDatabase(pg.url);
});

describe("reconciler (Postgres)", () => {
  test("exceptions row written, deduped hourly, explained; ledger sums venue_fills", async () => {
    if (!pg) return;
    const store = new PgExceptionStore(pg.conn.db);
    const ledger = new PgLedger(pg.conn.db);
    const { venue, mirror, rec, got } = await scenario(store, ledger);
    expect((await ledger.positions(1, ACCT, venue.name)).get(TSLA.toLowerCase())).toBe(-10n * E18);
    venue.st = { ...venue.st, positions: [{ underlying: TSLA, tokens: -12n * E18 }] };
    mirror.positions = [{ underlying: TSLA, tokens: -12n * E18 }];
    await rec.run();
    await rec.run();
    const rows = await pg.conn.sql`select kind, status, venue, underlying, detail from exceptions where account = ${ACCT.toLowerCase()}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reconcile.position", status: "open", venue: "orderly:0xabc", underlying: TSLA.toLowerCase() });
    expect(rows[0]!.detail).toMatchObject({ statement: (-12n * E18).toString(), ledger: (-10n * E18).toString() });
    expect(got).toHaveLength(1);
    expect(await breakGate(store, 1, ACCT).count()).toBe(1);
    const { id } = ((await pg.conn.sql`select id from exceptions where account = ${ACCT.toLowerCase()}`) as unknown as { id: number }[])[0]!;
    await store.explain(id, "fill of 2 TSLA recorded late by the desk", "ops");
    expect(await breakGate(store, 1, ACCT).count()).toBe(0);
  }, 30_000);
});

describe("PeriodClose gate", () => {
  test("a due close with an unexplained break refuses before building anything", async () => {
    const reads: string[] = [];
    const pub = {
      async readContract(a: { functionName: string }) {
        reads.push(a.functionName);
        const v: Record<string, unknown> = { closeCount: 0n, startTime: 0n, policy: MIRROR, versionAt: 1, policyAt: [{ periodSeconds: 100 }] };
        return v[a.functionName];
      },
      async getBlock() {
        return { timestamp: 1_000n };
      },
    } as unknown as PublicClient;
    const store = new MemoryExceptionStore();
    await store.upsertOpen(1, ACCT, { kind: "reconcile.position", key: "k", venue: "v", underlying: null, detail: {} });
    const ctx = { pub, periodClose: MIRROR, breaks: breakGate(store, 1, ACCT), say: () => {} } as unknown as CloseContext;
    expect(await closeOnce(ctx)).toEqual({ status: "blocked", periodEnd: 100n, reason: "unexplained_breaks", breaks: 1 });
    expect(reads).not.toContain("preview"); // nothing was built or signed
  });
});
