// Defects the fork run found and that are not fixed in this change. A failing step that matches one of these is
// reported as "known" (with the bug's repro and diagnosis) instead of failing the run; any other failure makes
// exercise.ts exit 1. Remove an entry when its fix lands: the step then has to pass.
export type KnownBug = {
  id: string;
  area: string;
  /** Step names (exact) or patterns this bug explains. */
  steps: (string | RegExp)[];
  title: string;
  repro: string;
  diagnosis: string;
};

export const KNOWN_BUGS: KnownBug[] = [];

/** Observations that are not failing steps but belong in the report. */
export const OBSERVATIONS: string[] = [];

/** Defects an earlier fork run found that this change fixes (each with its regression test); the run proves them. */
export const FIXED_BUGS: string[] = [
  "B1 (2026-10-06 run): Tier.maxDesks was enforced nowhere. TreasuryFactory now hands its tier source to every TreasuryAccount (initialize), and registerDesk refuses a desk beyond tierOf(board).maxDesks with TierTooLow(board, maxDesks); revoked desks do not count, and unstaking keeps the desks already registered (the tier is read when a desk is added). The fork board stakes 10,000 PLTH before its third desk. Tests: contracts/test/treasury/DeskTiers.t.sol.",
  "B2 (2026-10-06 run): PAUSED refused a neutral cash-to-cash redeem when rounding nudged the equity weight up. PolicyGuard treats an equity weight change within WEIGHT_DUST (1e12 WAD, 0.0001 percentage points) as no change in rules 7 and 8; a Stock Token buy is still refused whatever its size. Tests: PolicyGuard.t.sol (fuzzed boundary), test/fork/PausedRedeem.fork.t.sol (20 seconds on the real steakUSDG).",
  "B3 (2026-10-06 run): a treasury funded before its first desk had NAV 0. The PeriodClose's cash asset (USDG) is now always in trackedAssets and navUsd (TreasuryAccount.looseCash until a sleeve lists it), so the guard, the close, the fee and the CFO pack see it. Tests: contracts/test/treasury/LooseCash.t.sol.",
  "Perp gas headroom (2026-10-06 run): lib/gas.ts estimateGasAhead also estimates one second ahead (eth_estimateGas block override), so accrual a per-second path skips at estimate time is priced; AccountExecutor, the desk runner and this exercise use it (the exercise no longer widens the headroom). Test: app/src/lib/gas.anvil.test.ts.",
];
