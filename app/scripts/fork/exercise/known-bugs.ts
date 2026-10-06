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

export const KNOWN_BUGS: KnownBug[] = [
  {
    id: "B1",
    area: "token",
    steps: ["tier 0 board cannot register a third desk (maxDesks 2)"],
    title: "Tier.maxDesks is not enforced anywhere",
    repro:
      "Board with no PLTH stake (tier 0, maxDesks = 2) creates a treasury through TreasuryFactory and calls TreasuryAccount.registerDesk three times: the third registration succeeds.",
    diagnosis:
      "ITierSource documents maxDesks as factory-enforced, but neither TreasuryFactory nor TreasuryAccount reads it (the account has no tier source; registerDesk only checks its own arguments). Staking tiers therefore change weekly closes, private sleeves and template priority, but not desk limits. Fix: give TreasuryAccount the factory's tier source at initialize() and check the board's tier in registerDesk (a contract change with its own tests).",
  },
  {
    id: "B2",
    area: "treasury",
    steps: ["PAUSED: the cash desk moves $5k from steakUSDG back to USDG (cash -> cash)"],
    title: "In PAUSED, a cash-to-cash move (redeem vault shares to USDG) is refused by vault rounding",
    repro:
      "Treasury in PAUSED (drawdown between pauseNewRiskAtDrawdownBps and deriskAtDrawdownBps). Cash desk executes CashSleeve OP_REDEEM of $5k of steakUSDG shares: GuardRejected(9) R8_PAUSED, either in the simulation or, when the simulation passes, on chain one second later (seen both ways on 2026-10-06).",
    diagnosis:
      "PolicyGuard rule 8 (PAUSED) refuses any operation where the equity weight goes up (eqAfter > eqBefore). Redeeming ERC-4626 shares returns a few wei less USDG than the shares were valued at (vault rounding, and steakUSDG accrues every second), so NAV dips by dust and the equity weight rises by a rounding error: a neutral cash-to-cash move is treated as new risk, and whether it passes depends on the second it is mined. The same strict comparison exists in rule 7 (off-hours). Fix: compare weights with a dust tolerance (e.g. 1e12 WAD) or exempt operations whose equity value is unchanged; needs a PolicyGuard change and tests.",
  },
  {
    id: "B3",
    area: "treasury",
    steps: ["a treasury holding cash but no desks reports that cash in its NAV"],
    title: "NAV counts only assets of registered sleeves: a funded treasury with no desks closes at NAV 0",
    repro:
      "Deploy a treasury from the factory, send it 50,000 USDG, register no desk: TreasuryAccount.navUsd() = 0 and PeriodClose commits navUsd 0, so the platform fee (and the template author's share) is 0 and the period statement shows no assets.",
    diagnosis:
      "TreasuryAccount.trackedAssets() is built from the sleeves of registered desks only; the policy's cash asset (USDG, always allowed) is not tracked until a desk whose sleeve lists it is registered. Funds sent before that are invisible to the guard, the close and the CFO pack. Fix: always track the PeriodClose cash asset (or the policy's cash instruments) in trackedAssets, with tests for NAV, close and fee before any desk exists.",
  },
];

/** Observations that are not failing steps but belong in the report. */
export const OBSERVATIONS: string[] = [
  "Gas estimation on PerpMarket: on the 2026-10-06 run a 10k TSLA perp short estimated at ~283k gas and sent with the lib/gas.ts headroom (+25% +50k = 404,180) ran out of gas on chain (gasUsed = limit). The estimate is taken in the same second as the market's last accrual (accrual skipped), the mined transaction pays for it (todo 34's diagnosis), and here the extra cost exceeded the headroom. The exercise now sends with at least +50% +150k; the desk services (AccountExecutor, desk runner) still use lib/gas.ts and can hit the same out-of-gas on in-house perp opens. Suggested follow-up: a larger flat headroom for PerpMarket/PerpPool calls, or estimate against a block one second ahead.",
];

/** Defects the fork run found that are fixed in the same change (each with its regression test). */
export const FIXED_BUGS: string[] = [
  "SDK verifyDisclosure called Poseidon2 without loading it, so the API's stateless POST /v1/statements/verify answered 500 in a process that had not proved anything before (tests had always loaded it first). verifyDisclosure now loads it itself; sdk/test/disclosure-init.test.ts checks it in a fresh process.",
  "The API logged nothing for a 500: the REST handler now writes the cause to the service log (the client still sees only 'internal error').",
];
