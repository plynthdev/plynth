// Review v2, V2-L13: the RateLimiter (API, relayer, eligibility, imports) under many live keys, plus ipKey buckets.
// Before the fix the idle-key sweep ran inside every take once more than 10k keys were live: one IPv6 /48 (65,536
// /64 buckets) added ~0.8 ms to every request.
import { describe, expect, test } from "bun:test";
import { clientIp, ipKey, RateLimiter } from "./ratelimit";

describe("ipKey", () => {
  test("IPv6 by /64, IPv4-mapped as IPv4", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe(ipKey("2001:0db8:0001:0002::"));
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), true, () => "x")).toBe("1.2.3.4");
  });
});

describe("V2-L13: RateLimiter cost stays flat with many live keys", () => {
  test("one /48 (65,536 /64s) live: an honest take stays fast, and the map is capped", () => {
    const now = 1_000_000;
    const rl = new RateLimiter(600, 60_000, () => now);
    for (let i = 0; i < 65_536; i++) rl.take(ipKey(`2001:db8:aa:${i.toString(16)}::1`));
    expect(rl.size).toBeLessThanOrEqual(rl.maxKeys);
    const t1 = performance.now();
    for (let i = 0; i < 1000; i++) rl.take(`198.51.100.${i % 250}-${i}`);
    const perTakeMs = (performance.now() - t1) / 1000;
    expect(perTakeMs).toBeLessThan(0.05);
  });

  test("limits still hold, and the window slides", () => {
    let now = 0;
    const rl = new RateLimiter(3, 1_000, () => now);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
    expect(rl.take("b")).toBe(true);
    now = 999;
    expect(rl.take("a")).toBe(false);
    now = 1_001;
    expect(rl.take("a")).toBe(true);
  });

  test("idle keys are swept once per window, not per take", () => {
    let now = 0;
    const rl = new RateLimiter(5, 1_000, () => now);
    for (let i = 0; i < 100; i++) rl.take(`k${i}`);
    expect(rl.size).toBe(100);
    now = 2_000;
    rl.take("fresh");
    expect(rl.size).toBe(1);
  });

  test("LRU cap: the least recently used key goes first; a busy key is kept", () => {
    const now = 0;
    const rl = new RateLimiter(2, 60_000, () => now, 3);
    rl.take("busy");
    rl.take("busy");
    for (const k of ["x", "y", "z"]) {
      expect(rl.take("busy")).toBe(false); // still limited: touched every round, never evicted
      rl.take(k);
    }
    expect(rl.size).toBe(3);
    expect(rl.take("busy")).toBe(false);
  });
});
