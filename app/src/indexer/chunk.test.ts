import { describe, expect, test } from "bun:test";
import { ChunkSizer } from "./chunk";

describe("ChunkSizer", () => {
  test("starts at 5_000", () => {
    expect(new ChunkSizer().current).toBe(5_000);
  });

  test("halves on error down to min 50, then reports it cannot shrink", () => {
    const c = new ChunkSizer();
    const seen = [];
    while (c.fail()) seen.push(c.current);
    expect(seen).toEqual([2500, 1250, 625, 312, 156, 78, 50]);
    expect(c.current).toBe(50);
    expect(c.fail()).toBe(false);
  });

  test("doubles only after 5 consecutive successes, capped at 50_000", () => {
    const c = new ChunkSizer();
    for (let i = 0; i < 4; i++) c.success();
    expect(c.current).toBe(5_000);
    c.success();
    expect(c.current).toBe(10_000);
    for (let i = 0; i < 100; i++) c.success();
    expect(c.current).toBe(50_000);
  });

  test("an error resets the success streak", () => {
    const c = new ChunkSizer();
    for (let i = 0; i < 4; i++) c.success();
    c.fail();
    for (let i = 0; i < 4; i++) c.success();
    expect(c.current).toBe(2_500);
    c.success();
    expect(c.current).toBe(5_000);
  });

  test("rejects bad options", () => {
    expect(() => new ChunkSizer({ min: 0 })).toThrow();
    expect(() => new ChunkSizer({ min: 10, max: 5 })).toThrow();
  });

  test("fuzz: any success/fail sequence stays within [min, max] and is an integer", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let run = 0; run < 500; run++) {
      const min = 1 + Math.floor(rnd() * 100);
      const max = min + Math.floor(rnd() * 100_000);
      const c = new ChunkSizer({ min, max, initial: Math.floor(rnd() * 200_000) });
      for (let i = 0; i < 200; i++) {
        const before = c.current;
        if (rnd() < 0.4) {
          const shrank = c.fail();
          expect(shrank).toBe(before > min);
          if (shrank) expect(c.current).toBe(Math.max(min, Math.floor(before / 2)));
        } else c.success();
        expect(Number.isInteger(c.current)).toBe(true);
        expect(c.current).toBeGreaterThanOrEqual(min);
        expect(c.current).toBeLessThanOrEqual(max);
      }
    }
  });
});
