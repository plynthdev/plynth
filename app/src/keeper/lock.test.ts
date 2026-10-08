// One keeper per chain + deployment (Postgres session advisory lock), and the confirmed block every Quiet proof is
// read at. Real Postgres: a second lock on the same key is refused with a clear error; the lock goes with its session
// (a crash, a killed backend); a keeper that lost its session takes the lock again only while nobody else holds it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Address, PublicClient } from "viem";
import { loadConfig } from "@/config";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { confirmedBlock, keeperConfirmations } from "./context";
import { acquireKeeperLock, KeeperLockHeld, keeperLockKey, lockParts, type KeeperLock } from "./lock";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const DEP = { crowd: A(0xc0), vault: A(0xc2) };
const randBig = (bits: number) => BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(bits / 8))), (b) => b.toString(16).padStart(2, "0")).join("")}`) & ((1n << BigInt(bits)) - 1n);

let t: Awaited<ReturnType<typeof keeperTestDb>>;
const held: KeeperLock[] = [];
const take = async (key: bigint) => {
  const l = await acquireKeeperLock(t.url, key);
  held.push(l);
  return l;
};

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
      const rows = await t.sql`select pid from pg_locks where locktype = 'advisory' and granted and classid::bigint = ${classid}::bigint and objid::bigint = ${objid}::bigint and objsubid = 1`;
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
    const crashed = await take(key);
    const admin = postgres(t.url, { max: 1, onnotice: () => {} });
    try {
      await admin`select pg_terminate_backend(${crashed.pid()})`;
    } finally {
      await admin.end({ timeout: 5 });
    }
    let next: KeeperLock | undefined;
    for (let i = 0; i < 50 && !next; i++) {
      next = await acquireKeeperLock(t.url, key).catch(() => undefined);
      if (!next) await Bun.sleep(100);
    }
    expect(next).toBeDefined();
    held.push(next!);
    // the crashed keeper's client reconnects but must not run beside the new holder
    expect(await crashed.ensure().catch(() => crashed.ensure())).toBe(false);
    await next!.release();
  });

  test("a keeper whose session dropped takes the lock again when nobody else holds it", async () => {
    const key = keeperLockKey(46630, { ...DEP, crowd: A(0xd2) });
    const k = await take(key);
    const before = k.pid();
    const admin = postgres(t.url, { max: 1, onnotice: () => {} });
    try {
      await admin`select pg_terminate_backend(${before})`;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const ok = await k.ensure().catch(() => k.ensure()); // the first query after the kill may see the dead socket
    expect(ok).toBe(true);
    expect(k.pid()).not.toBe(before);
    expect(await acquireKeeperLock(t.url, key).catch((e) => e)).toBeInstanceOf(KeeperLockHeld);
    await k.release();
  });
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
