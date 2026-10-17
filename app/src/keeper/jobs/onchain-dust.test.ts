// Review v3, R3-SVC-2 (residual of V2-M5): on-chain round-ups had no minimum (jobs/roundups.ts passed minAccrueCents 0)
// and the roundups job runs before sweep / beacon / execute. A linked sybil sending 0.999999 USDG transfers (roundTo 1:
// a 1e-6 USDG round-up) got one keeper accrue per transfer: 87 accrues per pass, 87 micro-USDG moved, the whole 5M gas
// budget. Now the gate is configured the way runRoundups configures it, with the on-chain minimum, and lets none through.
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import type { Ctx } from "@/keeper/context";
import { AccrueGate, DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS, roundUpOf } from "@/keeper/sources/accrue";

const UNIT = 1_000_000n;
const GAS_PER_ACCRUE = 57_500n;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

function ctx(minOnchainAccrueCents?: number) {
  return {
    chainId: 31337,
    dep: { vault: A(0xc2) },
    db: { execute: async () => [{ n: 0 }] },
    accrueLimits: { perPass: 200, perUserWeek: 100, ...(minOnchainAccrueCents === undefined ? {} : { minOnchainAccrueCents }) },
    pub: {
      getBlock: async () => ({ timestamp: 1_800_000_000n }),
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "unit" ? UNIT : functionName === "settingsOf" ? { roundTo: 1, multiplier: 1, weeklyCap: 100n * UNIT } : { available: 1n * UNIT, week: 1_800_000_000n / 604_800n, accruedThisWeek: 0n },
    },
  } as unknown as Ctx;
}

/** The gate runRoundups builds (same expression as jobs/roundups.ts). */
const roundupsGate = (c: Ctx) => new AccrueGate(c, { minAccrueCents: c.accrueLimits?.minOnchainAccrueCents ?? DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS });

async function pass(gate: AccrueGate, spend: bigint) {
  const sybils = Array.from({ length: 20 }, (_, i) => A(0x1000 + i));
  let sent = 0;
  outer: for (let round = 0; round < 100; round++)
    for (const u of sybils) {
      const g = await gate.check(u, spend);
      if (!g.ok) {
        if (!g.skip && gate.passFull()) break outer;
        continue;
      }
      gate.record(u, spend, roundUpOf(spend, 1, 1, UNIT), GAS_PER_ACCRUE);
      sent++;
    }
  return sent;
}

describe("R3-SVC-2: on-chain dust spends buy no keeper accrues", () => {
  test("0.999999 USDG transfers (1e-6 USDG round-ups): no accrue at all in a pass", async () => {
    const gate = roundupsGate(ctx());
    expect(await pass(gate, 999_999n)).toBe(0);
    expect(gate.gasThisPass).toBe(0n);
    const why = await gate.check(A(0x1000), 999_999n);
    expect(why).toEqual({ ok: false, skip: true, reason: "round-up below the keeper minimum of 5 cents per accrual" });
  });

  test("the minimum is the round-up, not the spend: a $x.95 spend (5-cent round-up) still accrues; $x.96 does not", async () => {
    const gate = roundupsGate(ctx());
    expect((await gate.check(A(0x2001), 4_950_000n)).ok).toBe(true);
    expect((await gate.check(A(0x2002), 4_960_000n)).ok).toBe(false);
  });

  test("KEEPER_MIN_ONCHAIN_ACCRUE_CENTS sets it (0 restores the old behaviour, which the PoC exploited)", async () => {
    expect(await pass(roundupsGate(ctx(0)), 999_999n)).toBeGreaterThanOrEqual(80);
    expect(await pass(roundupsGate(ctx(25)), 4_950_000n)).toBe(0);
  });
});
