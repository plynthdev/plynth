// Drawdown state machine (spec §3). The on-chain PolicyGuard applies rule 8 instantly on every operation; this
// machine is the service's view of the same thresholds, with hysteresis so desks and humans are not flapped by
// a NAV that hovers on a line. It only informs (webhooks, desk scheduling); it never relaxes the guard.
//
//   normal  --dd <= pause-->  paused  --dd <= derisk-->  derisk
//   paused  --dd > pause + h-->  normal
//   derisk  --dd > derisk + h-->  paused (or normal if dd > pause + h)
// A new period (periodStartNav changed) or no period start yet re-evaluates without hysteresis.

export type DrawdownState = "normal" | "paused" | "derisk";

export type DrawdownInput = {
  nav: bigint; // USD 1e18
  periodStartNav: bigint; // USD 1e18, 0 = no close yet
  pauseBps: number; // policy.pauseNewRiskAtDrawdownBps (<= 0)
  deriskBps: number; // policy.deriskAtDrawdownBps (< pause)
};

export type DrawdownStep = {
  state: DrawdownState;
  ddBps: number | null; // floor((nav - start) / start * 10000), null without a period start
  changed: boolean;
  from: DrawdownState | null;
};

/** Same arithmetic as PolicyGuard rule 8: integer division truncating toward zero. */
export function drawdownBps(nav: bigint, start: bigint): number | null {
  if (start === 0n) return null;
  return Number(((nav - start) * 10_000n) / start);
}

/** The state the guard itself would apply at `dd` (no hysteresis). */
export function rawState(dd: number | null, pauseBps: number, deriskBps: number): DrawdownState {
  if (dd === null) return "normal";
  if (dd <= deriskBps) return "derisk";
  if (dd <= pauseBps) return "paused";
  return "normal";
}

export class DrawdownMachine {
  state: DrawdownState | null = null;
  private start: bigint | null = null;

  constructor(readonly hysteresisBps = 50) {
    if (hysteresisBps < 0) throw new Error("hysteresis must be >= 0");
  }

  step(i: DrawdownInput): DrawdownStep {
    const dd = drawdownBps(i.nav, i.periodStartNav);
    const raw = rawState(dd, i.pauseBps, i.deriskBps);
    const from = this.state;
    let next: DrawdownState;
    if (from === null || dd === null || this.start !== i.periodStartNav) {
      next = raw; // first look, or a new period: no memory to apply
    } else if (raw === "derisk" || (raw === "paused" && from === "normal")) {
      next = raw; // worsening always applies at once
    } else {
      // Improving: only leave a state once dd clears its threshold by the hysteresis.
      const h = this.hysteresisBps;
      const clearsPause = dd > i.pauseBps + h;
      const clearsDerisk = dd > i.deriskBps + h;
      if (from === "derisk") next = clearsPause ? "normal" : clearsDerisk ? "paused" : "derisk";
      else if (from === "paused") next = clearsPause ? "normal" : "paused";
      else next = "normal";
    }
    this.state = next;
    this.start = i.periodStartNav;
    return { state: next, ddBps: dd, changed: next !== from, from };
  }
}
