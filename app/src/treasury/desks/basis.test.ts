// Basis desk rules (todo 29): open only after N hours of positive funding with depth, room and normal markets;
// close on a flip, a cap breach or a drawdown state; carry reported as NAV per closed period, never a rate.
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { basisPeriodReport, decideBasis, depthOk, FundingStreaks, type BasisInput, type PairRow } from "./basis";

const E18 = 10n ** 18n;
const POS = 10n ** 12n; // longs pay
const ok: BasisInput = { fundingRate: POS, streakSec: 8 * 3600, openPairId: null, drawdown: "normal", offHours: false, depthOk: true, floatRoom: true, venueRoom: true, capBreached: false };

describe("FundingStreaks", () => {
  test("counts consecutive positive time and resets on zero or negative", () => {
    const s = new FundingStreaks();
    expect(s.observe("v:u", 0, POS)).toBe(0);
    expect(s.observe("v:u", 3600 * 7, POS)).toBe(3600 * 7);
    expect(s.observe("v:u", 3600 * 7 + 1, 0n)).toBe(0);
    expect(s.observe("v:u", 3600 * 8, POS)).toBe(0);
    expect(s.observe("v:u", 3600 * 16, POS)).toBe(3600 * 8);
    expect(s.observe("v:u", 3600 * 17, -POS)).toBe(0);
    expect(s.streak("v:u", 3600 * 18)).toBe(0);
  });
});

describe("decideBasis", () => {
  test("opens when every condition holds (default 8 hours)", () => {
    expect(decideBasis(ok, {})).toEqual({ action: "open", reason: "funding_positive" });
  });

  test("each missing condition holds the open back", () => {
    expect(decideBasis({ ...ok, streakSec: 8 * 3600 - 1 }, {}).reason).toBe("funding_streak_short");
    expect(decideBasis({ ...ok, streakSec: 4 * 3600 }, { fundingHours: 4 }).action).toBe("open");
    expect(decideBasis({ ...ok, fundingRate: 0n }, {}).reason).toBe("funding_not_positive");
    expect(decideBasis({ ...ok, depthOk: false }, {}).reason).toBe("spot_depth");
    expect(decideBasis({ ...ok, floatRoom: false }, {}).reason).toBe("float_cap");
    expect(decideBasis({ ...ok, venueRoom: false }, {}).reason).toBe("venue_cap");
    expect(decideBasis({ ...ok, offHours: true }, {}).reason).toBe("off_hours");
    expect(decideBasis({ ...ok, drawdown: "paused" }, {}).reason).toBe("drawdown_paused");
  });

  test("an open pair closes on a flip, a cap breach or a drawdown state; otherwise it carries", () => {
    const open = { ...ok, openPairId: 3n };
    expect(decideBasis(open, {})).toEqual({ action: "hold", reason: "carrying" });
    expect(decideBasis({ ...open, fundingRate: -1n }, {})).toEqual({ action: "close", reason: "funding_flip" });
    expect(decideBasis({ ...open, fundingRate: 0n }, {})).toEqual({ action: "close", reason: "funding_flip" });
    expect(decideBasis({ ...open, capBreached: true }, {})).toEqual({ action: "close", reason: "cap_breach" });
    expect(decideBasis({ ...open, drawdown: "derisk" }, {})).toEqual({ action: "close", reason: "drawdown_derisk" });
    expect(decideBasis({ ...open, drawdown: "paused" }, {})).toEqual({ action: "close", reason: "drawdown_paused" });
    expect(decideBasis({ ...open, fundingRate: -1n, offHours: true }, {}).action).toBe("close"); // reducing works off-hours
  });
});

describe("depthOk", () => {
  test("selling the lot back must lose no more than the slippage bound", () => {
    expect(depthOk(9_950n, 10_000n, 50)).toBe(true);
    expect(depthOk(9_949n, 10_000n, 50)).toBe(false);
  });
});

describe("basisPeriodReport", () => {
  const u = "0x0000000000000000000000000000000000000a01" as Address;
  const row = (id: bigint, closedAt: bigint, carry: bigint): PairRow => ({ id, underlying: u, spotRaw: E18, perpTokens: E18, entryPriceUsd: E18, collateral: 1n, openedAt: 1n, closedAt, cumulativeFundingUsd: carry });

  test("counts only pairs closed inside the period, as an absolute NAV amount with no rate field", () => {
    const r = basisPeriodReport([row(0n, 100n, 5n * E18), row(1n, 199n, -2n * E18), row(2n, 200n, 9n * E18), row(3n, 0n, 7n * E18)], 100n, 200n);
    expect(r).toEqual({ periodStart: 100n, periodEnd: 200n, pairsClosed: 2, navContributionUsd: 3n * E18 });
    for (const k of Object.keys(r)) expect(k.toLowerCase()).not.toMatch(/rate|apr|apy|yield|annual/);
  });
});
