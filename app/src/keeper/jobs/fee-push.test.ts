import { describe, expect, test } from "bun:test";
import { buySpend, feePushAction } from "./fee-push";

const T = 1_800_000_000n;

describe("fee-push decision (FeeRouter push is keeper-only, checked against an earlier observation)", () => {
  test("no observation yet: observe first, never push blind", () => {
    expect(feePushAction(T, 0n, 0n)).toBe("observe");
  });
  test("observation younger than 10 min: wait (the router would skip the buy)", () => {
    expect(feePushAction(T, 0n, T - 599n)).toBe("wait");
  });
  test("push due with an observation 10 min .. 2 h old: push", () => {
    expect(feePushAction(T, 0n, T - 600n)).toBe("push");
    expect(feePushAction(T, T - 3600n, T - 7200n)).toBe("push");
  });
  test("push not due yet: keep the observation fresh, otherwise wait", () => {
    expect(feePushAction(T, T - 100n, T - 1800n)).toBe("wait");
    expect(feePushAction(T, T - 100n, T - 3601n)).toBe("observe");
  });
  test("push due but the observation is older than 2 h: observe again", () => {
    expect(feePushAction(T, T - 9000n, T - 7201n)).toBe("observe");
  });
  test("buy spend mirrors the router: carry + half the new fees, capped", () => {
    expect(buySpend(3000n, 0n, 0n, 200n)).toBe(200n);
    expect(buySpend(1000n, 100n, 100n, 10_000n)).toBe(100n + 400n);
    expect(buySpend(100n, 100n, 0n, 10_000n)).toBe(100n);
  });
});
