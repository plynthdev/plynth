// Pure rules of the deliver-quiet job.
import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import { keeperDeployment } from "@/keeper/context";
import { classifySettlement, DEFAULT_SPLIT_PARTS, QUIET_ROUTE, releasable, releaseCheck, shuffle, splitAmount, splitParts, type Plan } from "./quiet";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("SPLIT_PARTS", () => {
  test("1-3, default 2; anything else is a startup error", () => {
    expect(splitParts(undefined)).toBe(DEFAULT_SPLIT_PARTS);
    expect(DEFAULT_SPLIT_PARTS).toBe(2);
    expect(splitParts("1")).toBe(1);
    expect(splitParts("3")).toBe(3);
    for (const bad of ["0", "4", "1.5", "two", "-1"]) expect(() => splitParts(bad)).toThrow(/SPLIT_PARTS/);
  });
});

describe("splitAmount", () => {
  test("parts are positive and sum exactly, for random weights and many totals", () => {
    for (let i = 0; i < 2000; i++) {
      const total = BigInt(Math.floor(Math.random() * 1e6)) * (i % 3 === 0 ? 10n ** 18n : 1n) + BigInt(i % 5);
      const n = 1 + (i % 3);
      const parts = splitAmount(total, n);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(parts.every((p) => p > 0n)).toBe(true);
      expect(parts.length).toBe(total === 0n ? 0 : Number(total < BigInt(n) ? total : BigInt(n)));
    }
  });

  test("zero allocation -> no parts; tiny allocation -> fewer parts of 1", () => {
    expect(splitAmount(0n, 3)).toEqual([]);
    expect(splitAmount(2n, 3)).toEqual([1n, 1n]);
  });

  test("extreme weights still give every part at least 1", () => {
    let k = 0;
    const rand = () => [1, 1000, 1][k++ % 3]!;
    const parts = splitAmount(10n, 3, rand);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(10n);
    expect(parts.every((p) => p >= 1n)).toBe(true);
  });

  test("random split is not a fixed ratio", () => {
    const firsts = new Set(Array.from({ length: 30 }, () => splitAmount(1_000_000n, 2)[0]));
    expect(firsts.size).toBeGreaterThan(5);
  });
});

describe("release schedule", () => {
  const plan = (releaseAts: number[]): Plan => ({
    asset: A(1),
    bookId: "0",
    user: A(2),
    allocation: "30",
    parts: releaseAts.map((releaseAt) => ({ stealth: A(9), ephemeralPublicKey: "0x02" as Hex, viewTag: "0x00" as Hex, raw: "10", releaseAt })),
  });

  test("part i waits for i more executions after the plan", () => {
    const p = plan([4, 5, 6]);
    expect(releasable(p, 4, new Set())).toEqual([0]);
    expect(releasable(p, 5, new Set([0]))).toEqual([1]);
    expect(releasable(p, 6, new Set())).toEqual([0, 1, 2]);
    expect(releasable(p, 6, new Set([0, 1, 2]))).toEqual([]);
    expect(releasable(p, 3, new Set())).toEqual([]);
  });

  test("shuffle is a permutation", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const s = shuffle(xs);
    expect([...s].sort((a, b) => a - b)).toEqual(xs);
    expect(xs).toEqual(Array.from({ length: 50 }, (_, i) => i)); // input untouched
  });
});

describe("route and deployment", () => {
  test("Quiet route is abi.encode(uint8 1)", () => {
    expect(decodeAbiParameters([{ type: "uint8" }], QUIET_ROUTE)).toEqual([1]);
  });

  test("stealthClaims is optional; registry defaults to the canonical ERC-6538 address", () => {
    const base = { chainId: 31337, savingsVault: A(1), crowdBuy: A(2), jitterBeacon: A(3), usdg: A(4) };
    const k = keeperDeployment(base, 31337);
    expect(k.stealthClaims).toBeUndefined();
    expect(k.erc6538Registry).toBe("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538");
    const q = keeperDeployment({ ...base, stealthClaims: A(5), erc6538Registry: A(6) }, 31337);
    expect(q.stealthClaims).toBe(A(5));
    expect(q.erc6538Registry).toBe(A(6));
  });
});

describe("settlement proof (E1)", () => {
  const CROWD = A(0xc0);
  const SC = A(0xc1);
  const ASSET = A(0x7e);
  const USER = A(0x22);
  const TX = `0x${"11".repeat(32)}` as Hex;
  const log = (address: Address, eventName: string, args: Record<string, unknown>, logIndex: number, tx: Hex = TX) => ({ address, eventName, args, transactionHash: tx, logIndex, blockNumber: 7n, blockHash: `0x${"07".repeat(32)}` as Hex });
  const delivered = (raw: bigint, i = 2) => log(CROWD, "Delivered", { asset: ASSET, bookId: 3n, user: USER, raw }, i);
  const pooled = (raw: bigint, i = 1, tx: Hex = TX, token = ASSET) => log(SC, "Pooled", { token, raw }, i, tx);
  const classify = (logs: ReturnType<typeof log>[]) => classifySettlement(logs, CROWD, SC, ASSET, "3", USER);

  test("Delivered right after StealthClaims' Pooled of the same raw, same tx: Quiet", () => {
    expect(classify([pooled(500n), delivered(500n)])).toEqual({ kind: "quiet", raw: 500n, tx: TX, via: "log" });
  });
  test("Delivered without that Pooled (Hidden route, another tx, another token, another raw, not adjacent): not Quiet", () => {
    expect(classify([delivered(500n)])?.kind).toBe("other-route");
    expect(classify([pooled(500n, 1, `0x${"22".repeat(32)}`), delivered(500n)])?.kind).toBe("other-route");
    expect(classify([pooled(500n, 1, TX, A(0x99)), delivered(500n)])?.kind).toBe("other-route");
    expect(classify([pooled(499n), delivered(500n)])?.kind).toBe("other-route");
    expect(classify([pooled(500n, 0), delivered(500n)])?.kind).toBe("other-route");
    expect(classify([log(A(0xee), "Pooled", { token: ASSET, raw: 500n }, 1), delivered(500n)])?.kind).toBe("other-route");
  });
  test("Claimed for the triple: claimed openly; logs for another user, book or contract: nothing", () => {
    expect(classify([log(CROWD, "Claimed", { asset: ASSET, bookId: 3n, user: USER, raw: 500n }, 1)])).toEqual({ kind: "claimed", tx: TX });
    expect(classify([pooled(500n), log(CROWD, "Delivered", { asset: ASSET, bookId: 3n, user: A(0x23), raw: 500n }, 2)])).toBeUndefined();
    expect(classify([pooled(500n), log(CROWD, "Delivered", { asset: ASSET, bookId: 4n, user: USER, raw: 500n }, 2)])).toBeUndefined();
    expect(classify([pooled(500n), log(A(0xee), "Delivered", { asset: ASSET, bookId: 3n, user: USER, raw: 500n }, 2)])).toBeUndefined();
  });
  test("a zero allocation pools nothing: Quiet with raw 0 (nothing to release)", () => {
    expect(classify([delivered(0n)])).toMatchObject({ kind: "quiet", raw: 0n });
  });

  const plan = (allocation: string, parts: string[], raw?: string): Plan => ({
    asset: ASSET,
    bookId: "3",
    user: USER,
    allocation,
    parts: parts.map((r) => ({ stealth: A(9), ephemeralPublicKey: "0x02" as Hex, viewTag: "0x00" as Hex, raw: r, releaseAt: 0 })),
    ...(raw === undefined ? {} : { delivered: { raw, tx: TX, via: "log" as const, atBlock: "7" } }),
  });
  test("release check: proven raw == allocation == sum of parts, else nothing goes out", () => {
    expect(releaseCheck(plan("500", ["200", "300"], "500"))).toEqual({ ok: true });
    expect(releaseCheck(plan("0", [], "0"))).toEqual({ ok: true });
    expect(releaseCheck(plan("500", ["200", "300"]))).toMatchObject({ ok: false, reason: "no delivery proof" });
    expect(releaseCheck(plan("500", ["200", "300"], "499"))).toMatchObject({ ok: false });
    expect(releaseCheck(plan("500", ["200", "301"], "500"))).toMatchObject({ ok: false });
    expect(releaseCheck(plan("500", ["200"], "500"))).toMatchObject({ ok: false });
  });
  test("fuzz: a random split of a random allocation always passes; any one-unit change to a part fails", () => {
    for (let i = 0; i < 500; i++) {
      const total = BigInt(Math.floor(Math.random() * 1e9)) * (i % 2 ? 10n ** 12n : 1n) + 1n;
      const parts = splitAmount(total, 1 + (i % 3)).map(String);
      expect(releaseCheck(plan(total.toString(), parts, total.toString())).ok).toBe(true);
      const k = i % parts.length;
      const bumped = parts.map((p, j) => (j === k ? (BigInt(p) + (i % 2 ? 1n : -1n)).toString() : p));
      expect(releaseCheck(plan(total.toString(), bumped, total.toString())).ok).toBe(false);
    }
  });
});
