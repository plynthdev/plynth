import { describe, expect, test } from "bun:test";
import { backoffDelay, isBackoffError, withRetry } from "./retry";

const err = (props: object) => Object.assign(new Error("x"), props);

describe("retry", () => {
  test("429 and 5xx (also nested as cause) and rate-limit RPC codes are backoff errors", () => {
    expect(isBackoffError(err({ status: 429 }))).toBe(true);
    expect(isBackoffError(err({ status: 503 }))).toBe(true);
    expect(isBackoffError(err({ cause: err({ status: 502 }) }))).toBe(true);
    expect(isBackoffError(err({ code: -32005 }))).toBe(true);
    expect(isBackoffError(err({ status: 400 }))).toBe(false);
    expect(isBackoffError(err({ code: -32602 }))).toBe(false);
    expect(isBackoffError(new Error("range too large"))).toBe(false);
  });

  test("withRetry retries backoff errors and returns the eventual result", async () => {
    let n = 0;
    const naps: number[] = [];
    const v = await withRetry(
      async () => {
        if (++n < 4) throw err({ status: 429 });
        return "ok";
      },
      { baseMs: 100, maxMs: 1000, maxAttempts: 8, random: () => 1, sleep: async (ms) => void naps.push(ms) },
    );
    expect(v).toBe("ok");
    expect(naps).toEqual([100, 200, 400]); // exponential (jitter pinned to 1)
  });

  test("withRetry throws non-backoff errors at once and gives up after maxAttempts", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw err({ status: 400 }); }, { baseMs: 1, maxMs: 1, maxAttempts: 5, sleep: async () => {} })).rejects.toThrow();
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => { n++; throw err({ status: 500 }); }, { baseMs: 1, maxMs: 1, maxAttempts: 5, sleep: async () => {} })).rejects.toThrow();
    expect(n).toBe(5);
  });

  test("fuzz: backoff delay is jittered within [0, min(max, base * 2^attempt)]", () => {
    for (let i = 0; i < 5_000; i++) {
      const attempt = Math.floor(Math.random() * 80);
      const baseMs = 1 + Math.floor(Math.random() * 2_000);
      const maxMs = baseMs + Math.floor(Math.random() * 60_000);
      const d = backoffDelay(attempt, { baseMs, maxMs });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30)));
      expect(Number.isInteger(d)).toBe(true);
    }
  });
});
