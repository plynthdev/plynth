// The deterministic rule juror: re-runs the PolicyGuard arithmetic (rules 3, 4, 7, 8 and the rule-9
// threshold) on the book as it would be after the operation, with the same integer maths as the contract.
// A board ticket only lifts rule 9; if any other rule would still fail, approving is pointless, so it says
// reject. It never sees the model jurors' answers.
import type { Band, ExceptionRequest, RuleCheck, RuleOpinion } from "./types";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** PolicyGuard._weight: part / nav in WAD, 0 when nav is 0. */
export const weightWad = (part: bigint, nav: bigint): bigint => (nav === 0n ? 0n : (part * WAD) / nav);

/** PolicyGuard.bandOk, bit for bit: in band, or moved strictly toward it from the same side. */
export function bandOk(band: Band, wBefore: bigint, wAfter: bigint): boolean {
  const lo = (BigInt(band.minBps) * WAD) / BPS;
  const hi = (BigInt(band.maxBps) * WAD) / BPS;
  if (wAfter < lo) return wBefore < wAfter;
  if (wAfter > hi) return wBefore > wAfter;
  return true;
}

/** Drawdown from the period-start NAV in bps, truncated toward zero like Solidity int division. */
export function drawdownBps(nav: bigint, start: bigint): bigint | null {
  if (start === 0n) return null;
  return ((nav - start) * BPS) / start;
}

/** How the operation moves the cash / equity buckets (USD 1e18). Cash-vault moves stay inside cash. */
export function project(action: string, notional: bigint): { cash: bigint; equity: bigint; stockUp: boolean } {
  switch (action) {
    case "buy":
      return { cash: -notional, equity: notional, stockUp: true };
    case "sell":
      return { cash: notional, equity: -notional, stockUp: false };
    case "deposit":
    case "redeem":
      return { cash: 0n, equity: 0n, stockUp: false };
    default:
      throw new Error(`rule juror: unknown action ${action}`);
  }
}

const usd = (v: bigint) => `$${(v / WAD).toString()}`;
const bps = (w: bigint) => Number((w * BPS) / WAD);

export function ruleJuror(req: ExceptionRequest): RuleOpinion {
  const p = req.policy;
  const n = BigInt(req.intent.notionalUsd);
  const nav = BigInt(req.weights.navUsd);
  const cash = BigInt(req.weights.cashUsd);
  const eq = BigInt(req.weights.equityUsd);
  const d = project(req.intent.action, n);
  const cashAfter = cash + d.cash;
  const eqAfter = eq + d.equity;
  // Fees/slippage are ignored: NAV is unchanged by a swap at the mark.
  const navAfter = nav;
  const cB = weightWad(cash, nav), cA = weightWad(cashAfter < 0n ? 0n : cashAfter, navAfter);
  const eB = weightWad(eq, nav), eA = weightWad(eqAfter < 0n ? 0n : eqAfter, navAfter);

  const checks: RuleCheck[] = [];
  const order = BigInt(p.perOrderCapUsd) * WAD;
  checks.push({ rule: "R3_ORDER_CAP", ok: n <= order, detail: `notional ${usd(n)} vs per-order cap ${usd(order)}` });
  const dayUsed = BigInt(req.market.dayUsedUsd);
  const day = BigInt(p.perDayCapUsd) * WAD;
  checks.push({ rule: "R3_DAY_CAP", ok: dayUsed + n <= day, detail: `24h used ${usd(dayUsed)} + ${usd(n)} vs day cap ${usd(day)}` });
  checks.push({ rule: "R3_FUNDS", ok: cashAfter >= 0n && eqAfter >= 0n, detail: `cash after ${usd(cashAfter)}, equity after ${usd(eqAfter)}` });
  const cashOk = navAfter === 0n || bandOk(p.cash, cB, cA);
  const eqOk = navAfter === 0n || bandOk(p.equity, eB, eA);
  checks.push({ rule: "R4_BAND_CASH", ok: cashOk, detail: `cash ${bps(cB)} -> ${bps(cA)} bps, band ${p.cash.minBps}-${p.cash.maxBps}` });
  checks.push({ rule: "R4_BAND_EQUITY", ok: eqOk, detail: `equity ${bps(eB)} -> ${bps(eA)} bps, band ${p.equity.minBps}-${p.equity.maxBps}` });
  const offHours = p.noNewRiskOffHours && req.market.equityHold && !(eA < eB);
  checks.push({ rule: "R7_OFF_HOURS", ok: !offHours, detail: req.market.equityHold ? "a held feed is on hold: only equity-reducing operations" : "markets open" });
  const dd = drawdownBps(nav, BigInt(req.market.periodStartNavUsd));
  let r8 = true;
  let r8d = "no period-start NAV yet";
  if (dd !== null) {
    if (dd <= BigInt(p.deriskAtDrawdownBps)) {
      r8 = !d.stockUp && cA > cB;
      r8d = `drawdown ${dd} bps <= derisk ${p.deriskAtDrawdownBps}: only moves toward cash`;
    } else if (dd <= BigInt(p.pauseNewRiskAtDrawdownBps)) {
      r8 = !d.stockUp && !(eA > eB);
      r8d = `drawdown ${dd} bps <= pause ${p.pauseNewRiskAtDrawdownBps}: only risk-reducing operations`;
    } else r8d = `drawdown ${dd} bps, above pause ${p.pauseNewRiskAtDrawdownBps}`;
  }
  checks.push({ rule: "R8_DRAWDOWN", ok: r8, detail: r8d });
  const needsTicket = n > BigInt(p.approvalAboveUsd) * WAD;

  const failed = checks.filter((c) => !c.ok);
  const reasons = failed.length
    ? failed.map((c) => `${c.rule} would still fail after approval: ${c.detail}`)
    : [needsTicket ? `only rule 9 (board sign-off above ${usd(BigInt(p.approvalAboveUsd) * WAD)}) blocks it; every other guard rule passes` : "no rule blocks it and it does not need a ticket"];
  return {
    juror: "rules",
    recommend: failed.length ? "reject" : "approve",
    confidence: 1,
    reasons,
    needsTicket,
    checks,
    projected: { navUsd: navAfter.toString(), cashBpsBefore: bps(cB), cashBpsAfter: bps(cA), equityBpsBefore: bps(eB), equityBpsAfter: bps(eA), drawdownBps: dd === null ? null : Number(dd) },
  };
}
