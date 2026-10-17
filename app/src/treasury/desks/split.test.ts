// Equity desk order splitting: a buy too big for the pool at the guard's slippage is filled in pieces that each pass.
import { describe, expect, test } from "bun:test";
import { splitFill, type Probe } from "./split";

const U = 1_000_000n;

/** A pool that takes any single order up to `depth` USDG within the slippage; each fill uses up `decay` of depth. */
function pool(depth: bigint, decay = 0n, reason = "Slippage") {
  const sent: bigint[] = [];
  let d = depth;
  const probe: Probe = async (a) => (a <= d ? { ok: true } : { ok: false, reason });
  const send = async (a: bigint) => {
    sent.push(a);
    d = d > decay ? d - decay : 0n;
    return true;
  };
  return { probe, send, sent };
}

describe("splitFill", () => {
  test("an order the pool takes whole is sent once", async () => {
    const p = pool(10_000n * U);
    const r = await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send);
    expect(r).toEqual({ filled: 9_000n * U, sends: 1 });
    expect(p.sent).toEqual([9_000n * U]);
  });

  test("a $9k buy into a pool that takes $2.5k per order within 50 bps: four pieces, each within the guard", async () => {
    const p = pool(2_500n * U);
    const r = await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send);
    expect(r.filled).toBe(9_000n * U);
    expect(r.stuck).toBeUndefined();
    expect(p.sent.every((a) => a <= 2_500n * U)).toBe(true);
    expect(p.sent.reduce((a, b) => a + b, 0n)).toBe(9_000n * U);
    expect(p.sent).toEqual([2_250n * U, 2_250n * U, 2_250n * U, 2_250n * U]); // 9000 -> 4500 -> 2250, then repeated
  });

  test("each fill moves the pool: pieces keep halving, and what a minimum piece cannot fill waits for a later pass", async () => {
    const p = pool(3_000n * U, 1_000n * U); // 3000, then 2000, 1000, 0 of depth
    const r = await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send);
    expect(r.filled).toBe(p.sent.reduce((a, b) => a + b, 0n));
    expect(r.filled).toBeLessThan(9_000n * U);
    expect(r).toMatchObject({ stuck: "min piece", retryLater: true });
    expect(p.sent.every((a) => a >= 250n * U)).toBe(true);
  });

  test("a pool off the oracle (even the minimum piece slips): nothing is sent, retried later", async () => {
    const p = pool(0n);
    expect(await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send)).toEqual({ filled: 0n, sends: 0, stuck: "min piece", retryLater: true });
    expect(p.sent).toEqual([]);
  });

  test("a guard loss-bound rejection (R6_UNKNOWN_CHANGE) is a size problem too", async () => {
    const p = pool(5_000n * U, 0n, "R6_UNKNOWN_CHANGE");
    expect((await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send)).filled).toBe(9_000n * U);
  });

  test("a rule rejection (band, cap, pause) is not split and not retried", async () => {
    const p = pool(0n, 0n, "R4_BAND");
    expect(await splitFill(9_000n * U, 250n * U, 16, p.probe, p.send)).toEqual({ filled: 0n, sends: 0, stuck: "R4_BAND" });
  });

  test("the send budget bounds the pieces per pass; the rest is retried later", async () => {
    const p = pool(300n * U);
    const r = await splitFill(9_000n * U, 250n * U, 3, p.probe, p.send);
    expect(r).toMatchObject({ sends: 3, stuck: "max sends", retryLater: true });
    expect(p.sent.length).toBe(3);
  });

  test("a piece that reverts on-chain stops the name for this pass", async () => {
    const r = await splitFill(1_000n * U, 250n * U, 16, async () => ({ ok: true }), async () => false);
    expect(r).toEqual({ filled: 0n, sends: 0, stuck: "reverted" });
  });
});
