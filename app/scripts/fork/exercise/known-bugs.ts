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
  "Security review 2026-10-06 (S1-S13), fixed and re-run here: PerpPool cooldown cannot be re-dated (no transfers in cooldown, no 0 deposits); every market accrues before pool liquidity changes; LP entries/exits pause while open interest is priced stale; hold exits pay the largest plausible gap (10% default); in-house venue equity is what a close pays; insurance deposits refused while claims own the pool and withdrawing shares stop earning; FeeRouter push/observe keeper-only against an earlier observation; JitterBeacon offset domain-separated and revealed only at its time; CrowdBuy execute keeper-only until windowEnd - GRACE (then half slippage); spend proofs bind the encrypted notes; zero-value notes take no leaf and full trees roll over; the keeper sender never sends a second transaction after a broadcast. Steps whose behaviour changed: keeper-only execute and push, reveal at the execution time, outsiders refused.",
  "Delta review 2026-10-07 (insurance LP accounting): withdrawing LPs are a fixed liability and active shares are priced on what they own, so a deposit just before a large exit captures nothing; when no active share is left the surplus goes back to the FeeRouter (which routes to stakers while no LP is active); deposits need the active share price at >= 50% of entry and depositFees is router-only, so a 1-wei donation or claim dust cannot reopen deposits at ~0 price.",
  "Delta review 2026-10-07 (keeper deliver-quiet): a deliverStealth that ended in TxUnconfirmed (or a dropped connection after the node took it) is never followed by a second transaction while the first may mine: the hash, nonce and signed bytes are stored before the broadcast, later passes check that receipt and the keeper nonce, rebroadcast only the same bytes, and resend only after the nonce was provably taken by another transaction (grace period + a re-check pinned to that block).",
];
