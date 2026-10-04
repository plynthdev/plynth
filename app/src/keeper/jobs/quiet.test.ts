// Pure rules of the deliver-quiet job.
import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import { keeperDeployment } from "@/keeper/context";
import { DEFAULT_SPLIT_PARTS, QUIET_ROUTE, releasable, shuffle, splitAmount, splitParts, type Plan } from "./quiet";

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
