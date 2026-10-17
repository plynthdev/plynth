// Review v2, V2-L16 (API-3): desk.list scanned the account's whole log history on every request, ~2,500 getLogs per
// request after one year of RHC blocks (~345k a day). Now one background scan per account, then only new blocks.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { isHeavyPath } from "./app";
import { DeskIndex, DeskIndexBehind } from "./desk-index";

const ACCT = "0x00000000000000000000000000000000000000a5" as Address;
const DESK = `0x${"63".padEnd(64, "0")}` as Hex;

function chain(days: number) {
  const calls = { logs: 0 };
  let head = 1n + BigInt(days) * 345_600n;
  const pub = { getBlockNumber: async () => head };
  const logs = async (_a: Address, from: bigint, to: bigint) => {
    calls.logs++;
    return from <= 5n && 5n <= to ? [DESK] : [];
  };
  return { calls, pub, logs, grow: (n: bigint) => (head += n) };
}

describe("V2-L16: DeskRegistered scans are cached", () => {
  test("after the first scan, a request costs at most 2 getLogs at 1 year of chain age", async () => {
    const c = chain(365);
    const ix = new DeskIndex({ waitMs: 5_000 });
    expect(await ix.ids(c.pub, ACCT, 1n, c.logs)).toEqual([DESK]);
    const first = c.calls.logs;
    expect(first).toBeGreaterThan(2_000); // the one-time scan
    c.grow(1_000n);
    const before = c.calls.logs;
    expect(await ix.ids(c.pub, ACCT, 1n, c.logs)).toEqual([DESK]);
    expect(c.calls.logs - before).toBeLessThan(10);
    expect(c.calls.logs - before).toBeLessThanOrEqual(2);
  });

  test("while the first scan runs, concurrent requests share it (503 after the wait), never start another", async () => {
    const c = chain(365);
    const slow = async (a: Address, f: bigint, t: bigint) => (await Bun.sleep(1), c.logs(a, f, t));
    const ix = new DeskIndex({ waitMs: 20 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => ix.ids(c.pub, ACCT, 1n, slow)));
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof DeskIndexBehind)).toBe(true);
    // one scan in flight: far fewer calls than 20 full scans
    expect(c.calls.logs).toBeLessThan(2_600);
  });

  test("desk and close routes are heavy", () => {
    for (const p of [`/v1/treasury/${ACCT}/desks`, `/v1/treasury/${ACCT}/closes`, `/v1/treasury/${ACCT}/closes/3`, "/trpc/desk.list", "/trpc/close.get", "/trpc/close.list"]) expect(isHeavyPath(p), p).toBe(true);
    expect(isHeavyPath(`/v1/treasury/${ACCT}/nav`)).toBe(false);
  });
});
