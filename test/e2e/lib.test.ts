// Unit tests for the e2e plumbing: a mismatch must turn into a non-zero exit, and the independent 6-decimal
// formatter the scenarios compare the API against must truncate exactly like the API's display format.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fixed as apiFixed } from "../../apps/api/src/format";
import { Checks, fixed6, ROOT } from "./lib";

describe("Checks", () => {
  test("all checks passing exits 0", () => {
    const c = new Checks("unit");
    c.ok("a", true);
    c.eq("b", 5n, 5n);
    c.eq("c", { x: 1n, y: ["z"] }, { x: 1n, y: ["z"] });
    expect(c.finish()).toBe(0);
    expect(c.passed).toBe(3);
  });

  test("any mismatch exits 1 and is named", () => {
    const c = new Checks("unit");
    c.ok("fine", true);
    c.eq("nav", 100n, 101n);
    expect(c.finish()).toBe(1);
    expect(c.failed).toEqual(["nav"]);
  });

  test("must() stops the scenario on a failed precondition", () => {
    const c = new Checks("unit");
    expect(() => c.must("deployed", false)).toThrow("precondition failed: deployed");
    expect(c.finish()).toBe(1);
  });
});

describe("fixed6", () => {
  test("matches the API formatter for USDG (6 dp) and USD (18 dp), truncating", () => {
    for (const [x, d] of [
      [0n, 6],
      [1n, 6],
      [13_500_000n, 6],
      [999_999_999_999n, 18],
      [123_456_789_123_456_789_123n, 18],
      [10n ** 18n - 1n, 18],
    ] as const) {
      expect(fixed6(x, d)).toBe(apiFixed(x, d));
    }
    expect(fixed6(4_500_000n, 6)).toBe("4.500000");
    expect(fixed6(1_999_999_999_999_999n, 18)).toBe("0.001999");
  });
});

describe("scripts/e2e.sh", () => {
  test("refuses an unknown scenario with a usage error before starting anything", () => {
    const r = Bun.spawnSync(["bash", join(ROOT, "scripts", "e2e.sh"), "nope"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(64);
    expect(r.stderr.toString()).toContain("usage:");
  });
});
