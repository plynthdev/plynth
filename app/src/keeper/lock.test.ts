// One keeper per chain + deployment (Postgres session advisory lock), and the confirmed block every Quiet proof is
// read at. Real Postgres: a second lock on the same key is refused with a clear error; the lock goes with its session
// (a crash, a killed backend); a keeper that lost its session takes the lock again only while nobody else holds it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Address, PublicClient } from "viem";
import { loadConfig } from "@/config";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { confirmedBlock, keeperConfirmations } from "./context";
import { acquireKeeperLock, KeeperLockHeld, keeperLockKey, lockParts, type KeeperLock, type KeeperLockOptions } from "./lock";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const DEP = { crowd: A(0xc0), vault: A(0xc2) };
const randBig = (bits: number) => BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(bits / 8))), (b) => b.toString(16).padStart(2, "0")).join("")}`) & ((1n << BigInt(bits)) - 1n);

let t: Awaited<ReturnType<typeof keeperTestDb>>;
const held: KeeperLock[] = [];
const take = async (key: bigint, opts?: KeeperLockOptions) => {
  const l = await acquireKeeperLock(t.url, key, opts);
  held.push(l);
  return l;
};
/** Ends a session the way a crash or a database restart does, and returns once the server has removed it. */
const kill = async (pid: number) => {
  const admin = postgres(t.url, { max: 1, onnotice: () => {} });
  try {
    expect((await admin`select pg_terminate_backend(${pid}, 10000) as gone`)[0]?.gone).toBe(true);
  } finally {
    await admin.end({ timeout: 5 });
  }
};
/** Holders of a key in THIS test database (advisory locks are per database; other test files share the server). */
const holders = async (key: bigint) => {
  const { classid, objid } = lockParts(key);
  const rows = await t.sql`select pid from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())
    and classid::bigint = ${classid}::bigint and objid::bigint = ${objid}::bigint and objsubid = 1`;
  return rows.map((r) => Number(r.pid));
};
const alive = async (pid: number) => (await t.sql`select 1 from pg_stat_activity where pid = ${pid}`).length > 0;
type Sql = ReturnType<typeof postgres>;
/**
 * A dedicated-connection factory for the lock whose FIRST client can be made to stop answering (what postgres.js
 * does after a dropped socket, about 1 in 4 times under load), and whose end() can be delayed (a server that has not
 * noticed the closed socket yet). Later clients are plain.
 */
function flakyConnect(opts: { lingerMs?: number; failOpens?: number } = {}) {
  let n = 0;
  let stuck = false;
  const connect = (url: string): Sql => {
    n++;
    if (n > 1 && opts.failOpens && n <= 1 + opts.failOpens) return postgres("postgres://127.0.0.1:1/unreachable", { max: 1, connect_timeout: 1, onnotice: () => {} });
    const real = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {}, connection: { application_name: "plynth-keeper" } });
    if (n > 1) return real;
    const f = ((strings: TemplateStringsArray, ...v: unknown[]) => (stuck ? new Promise(() => {}) : real(strings, ...(v as never[])))) as unknown as Sql;
    (f as { end: Sql["end"] }).end = (async (o?: { timeout?: number }) => {
      if (opts.lingerMs) await Bun.sleep(opts.lingerMs);
      return real.end(o);
    }) as Sql["end"];
    return f;
  };
  return { connect, stick: () => (stuck = true), opens: () => n };
}

beforeAll(async () => {
  t = await keeperTestDb("lock");
});
afterAll(async () => {
  for (const l of held) await l.release().catch(() => {});
  await t?.drop();
});

describe("keeper lock key", () => {
  test("fixed per chain + deployment: same inputs same key, another chain or deployment another key", () => {
    const k = keeperLockKey(46630, DEP);
    expect(keeperLockKey(46630, { crowd: DEP.crowd.toUpperCase().replace("0X", "0x") as Address, vault: DEP.vault })).toBe(k);
    expect(keeperLockKey(4663, DEP)).not.toBe(k);
    expect(keeperLockKey(46630, { ...DEP, crowd: A(0xc9) })).not.toBe(k);
    expect(keeperLockKey(46630, { ...DEP, vault: A(0xc9) })).not.toBe(k);
  });

  test("always a Postgres bigint; classid/objid split round-trips (fuzz)", () => {
    for (let i = 0; i < 2_000; i++) {
      const chainId = 1 + Math.floor(Math.random() * 1_000_000);
      const k = keeperLockKey(chainId, { crowd: `0x${randBig(160).toString(16).padStart(40, "0")}` as Address, vault: DEP.vault });
      expect(k >= -(1n << 63n) && k < 1n << 63n).toBe(true);
      const { classid, objid } = lockParts(k);
      expect(classid >= 0 && classid < 2 ** 32 && objid >= 0 && objid < 2 ** 32).toBe(true);
      expect(BigInt.asIntN(64, (BigInt(classid) << 32n) | BigInt(objid))).toBe(k);
    }
  });

  test("pg_locks shows the key at exactly lockParts(key)", async () => {
    const key = -keeperLockKey(1, DEP) || 1n; // a negative key too
    for (const k of [key, -key]) {
      const l = await take(k);
      const { classid, objid } = lockParts(k);
      const rows = await t.sql`select pid from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())
        and classid::bigint = ${classid}::bigint and objid::bigint = ${objid}::bigint and objsubid = 1`;
      expect(rows.map((r) => Number(r.pid))).toEqual([l.pid()]);
      await l.release();
    }
  });
});

describe("single keeper (session advisory lock)", () => {
  test("two keepers on one key -> the second is refused with a clear error naming the holder; another chain is independent", async () => {
    const key = keeperLockKey(46630, DEP);
    const first = await take(key);
    const err = await acquireKeeperLock(t.url, key).catch((e) => e);
    expect(err).toBeInstanceOf(KeeperLockHeld);
    expect(err.message).toContain("another keeper already runs for this chain and deployment");
    expect(err.message).toContain(`pid ${first.pid()}`);
    expect(err.message).toContain("plynth-keeper");
    const other = await take(keeperLockKey(4663, DEP)); // another chain: its own keeper
    expect(await other.ensure()).toBe(true);
    expect(await first.ensure()).toBe(true);
    await first.release();
    const second = await take(key); // released -> the next keeper may run
    expect(await second.ensure()).toBe(true);
    await second.release();
    await other.release();
  });

  test("the lock lives in the database session: a crashed keeper's session ends and the lock is free again", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd1) });
    const crashed = await take(key, { queryTimeoutMs: 2_000 });
    await kill(crashed.pid());
    let next: KeeperLock | undefined;
    for (let i = 0; i < 50 && !next; i++) {
      next = await acquireKeeperLock(t.url, key).catch(() => undefined);
      if (!next) await Bun.sleep(100);
    }
    expect(next).toBeDefined();
    held.push(next!);
    // the crashed keeper's client reconnects but must not run beside the new holder
    expect(await crashed.ensure()).toBe(false);
    expect(await holders(key)).toEqual([next!.pid()]);
    await next!.release();
  }, 30_000);

  test("a keeper whose session dropped takes the lock again when nobody else holds it (killed session not yet removed too)", async () => {
    for (const wait of [true, false]) {
      const key = keeperLockKey(46630, { ...DEP, crowd: A(wait ? 0xd2 : 0xd3) });
      const k = await take(key, { queryTimeoutMs: 2_000 });
      const before = k.pid();
      if (wait) await kill(before);
      else {
        // no wait for the server to remove the session: postgres.js may reconnect while the old one still holds the lock
        const admin = postgres(t.url, { max: 1, onnotice: () => {} });
        await admin`select pg_terminate_backend(${before})`.finally(() => admin.end({ timeout: 5 }));
      }
      expect(await k.ensure()).toBe(true); // one call: no retry needed by the caller
      expect(k.pid()).not.toBe(before);
      expect(await holders(key)).toEqual([k.pid()]);
      expect(await acquireKeeperLock(t.url, key).catch((e) => e)).toBeInstanceOf(KeeperLockHeld);
      expect(await k.ensure()).toBe(true);
      await k.release();
      expect(await holders(key)).toEqual([]);
    }
  }, 30_000);

  test("a lock query that never answers (postgres.js after a dropped socket) times out; the next connection re-takes the lock", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd4) });
    const f = flakyConnect();
    const k = await take(key, { queryTimeoutMs: 300, connect: f.connect });
    const before = k.pid();
    await kill(before);
    f.stick();
    const t0 = Date.now();
    expect(await k.ensure()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(f.opens()).toBe(2);
    expect(k.pid()).not.toBe(before);
    expect(await holders(key)).toEqual([k.pid()]);
    await k.release();
    expect(await holders(key)).toEqual([]);
  }, 30_000);

  test("a stuck connection whose session is still alive: ensure drops it, waits for it to leave, never two holders", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd5) });
    const f = flakyConnect({ lingerMs: 700 }); // the old session keeps the lock 700 ms after we give up on it
    const k = await take(key, { queryTimeoutMs: 300, retakeWaitMs: 10_000, connect: f.connect });
    const before = k.pid();
    f.stick();
    const t0 = Date.now();
    expect(await k.ensure()).toBe(true); // not false: our own leaving session is not "another keeper"
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    expect(k.pid()).not.toBe(before);
    expect(await alive(before)).toBe(false);
    expect(await holders(key)).toEqual([k.pid()]);
    await k.release();
  }, 30_000);

  test("our old session outlives the re-take wait: ensure throws (the pass is skipped, the keeper keeps running) and recovers later", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd6) });
    const f = flakyConnect({ lingerMs: 2_000 });
    const k = await take(key, { queryTimeoutMs: 300, retakeWaitMs: 300, connect: f.connect });
    const before = k.pid();
    f.stick();
    expect(await k.ensure().catch((e) => e)).toBeInstanceOf(Error);
    expect(await holders(key)).toEqual([before]); // still only the old session; nobody runs beside it
    await Bun.sleep(2_200);
    expect(await k.ensure()).toBe(true);
    expect(await holders(key)).toEqual([k.pid()]);
    await k.release();
  }, 30_000);

  test("database unreachable while re-taking: ensure throws, then re-takes on a fresh connection once it is back", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd7) });
    const f = flakyConnect({ failOpens: 1 });
    const k = await take(key, { queryTimeoutMs: 2_000, connect: f.connect });
    const before = k.pid();
    await kill(before);
    f.stick();
    const err = await k.ensure().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KeeperLockHeld);
    expect(await k.ensure()).toBe(true);
    expect(f.opens()).toBe(3);
    expect(await holders(key)).toEqual([k.pid()]);
    await k.release();
  }, 30_000);
});

describe("confirmations", () => {
  test("KEEPER_CONFIRMATIONS: 2 on testnet and mainnet, 0 on local, an explicit value wins", () => {
    expect(keeperConfirmations("testnet", undefined)).toBe(2);
    expect(keeperConfirmations("mainnet", undefined)).toBe(2);
    expect(keeperConfirmations("local", undefined)).toBe(0);
    expect(keeperConfirmations("testnet", 0)).toBe(0);
    expect(keeperConfirmations("local", 5)).toBe(5);
    expect(loadConfig({}).KEEPER_CONFIRMATIONS).toBeUndefined();
    expect(loadConfig({ KEEPER_CONFIRMATIONS: "3" }).KEEPER_CONFIRMATIONS).toBe(3);
    expect(() => loadConfig({ KEEPER_CONFIRMATIONS: "-1" })).toThrow(/KEEPER_CONFIRMATIONS/);
  });

  test("the confirmed block is head - confirmations, never below 0, read uncached (fuzz)", async () => {
    for (let i = 0; i < 2_000; i++) {
      const head = i < 50 ? BigInt(i) : randBig(40);
      const conf = Math.floor(Math.random() * 100);
      let opts: unknown;
      const pub = { getBlockNumber: async (o: unknown) => ((opts = o), head) } as unknown as PublicClient;
      const r = await confirmedBlock({ pub, confirmations: conf });
      expect(r.head).toBe(head);
      expect(r.at).toBe(head > BigInt(conf) ? head - BigInt(conf) : 0n);
      expect(r.at >= 0n && r.at <= head && head - r.at <= BigInt(conf)).toBe(true);
      expect(opts).toEqual({ cacheTime: 0 });
    }
    const pub = { getBlockNumber: async () => 7n } as unknown as PublicClient;
    expect((await confirmedBlock({ pub })).at).toBe(7n); // absent = 0 confirmations
  });
});
