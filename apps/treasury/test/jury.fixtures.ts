// Shared fixtures for the jury tests: a balanced-template exception (buy $60k of a Stock Token on a $200k
// all-cash book: in band after, but above the $50k board threshold) and an in-memory JuryStore.
import type { JuryRow, JuryStore } from "../jury/store";
import type { ExceptionRequest, JuryBundle } from "../jury/types";

export const W = 10n ** 18n;
export const usd = (n: bigint | number) => (BigInt(n) * W).toString();

export function exceptionReq(over: { intent?: Partial<ExceptionRequest["intent"]>; weights?: Partial<ExceptionRequest["weights"]>; market?: Partial<ExceptionRequest["market"]>; policy?: Partial<ExceptionRequest["policy"]> } = {}): ExceptionRequest {
  return {
    chainId: 31337,
    account: "0x00000000000000000000000000000000000000aa",
    approvals: "0x00000000000000000000000000000000000000bb",
    desk: "equity",
    opHash: `0x${"11".repeat(32)}`,
    intent: { action: "buy", asset: "0x00000000000000000000000000000000000000cc", amount: "60000000000", notionalUsd: usd(60_000), ...over.intent },
    policy: {
      cash: { minBps: 4000, maxBps: 7000 },
      equity: { minBps: 3000, maxBps: 6000 },
      perOrderCapUsd: "100000",
      perDayCapUsd: "500000",
      approvalAboveUsd: "50000",
      noNewRiskOffHours: true,
      pauseNewRiskAtDrawdownBps: -400,
      deriskAtDrawdownBps: -800,
      ...over.policy,
    },
    weights: { navUsd: usd(200_000), cashUsd: usd(200_000), equityUsd: "0", ...over.weights },
    guard: { code: 11, reason: "R9_APPROVAL" },
    market: { timestamp: 1_800_000_000, equityHold: false, dayUsedUsd: "0", periodStartNavUsd: "0", ...over.market },
  };
}

export class MemoryJuryStore implements JuryStore {
  rows: JuryRow[] = [];
  async insert(b: JuryBundle, json: string, hash: string) {
    const r = b.request;
    const row: JuryRow = {
      id: this.rows.length + 1,
      chainId: r.chainId,
      approvals: r.approvals.toLowerCase(),
      account: r.account.toLowerCase(),
      desk: r.desk,
      opHash: r.opHash.toLowerCase(),
      bundleHash: hash.toLowerCase(),
      bundleJson: json,
      mode: b.mode,
      recommendation: b.verdict.recommend,
      ruleRecommendation: b.rules.recommend,
      status: "deliberated",
      ticket: null,
      txHash: null,
      error: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row.id;
  }
  async markRequested(id: number, ticket: string, txHash: string) {
    Object.assign(this.rows[id - 1]!, { status: "requested", ticket: ticket.toLowerCase(), txHash });
  }
  async markFailed(id: number, error: string) {
    Object.assign(this.rows[id - 1]!, { status: "failed", error });
  }
  async byHash(chainId: number, approvals: string, hash: string) {
    return this.rows.find((r) => r.chainId === chainId && r.approvals === approvals.toLowerCase() && r.bundleHash === hash.toLowerCase());
  }
  async byTicket(chainId: number, approvals: string, ticket: string) {
    return this.rows.find((r) => r.chainId === chainId && r.approvals === approvals.toLowerCase() && r.ticket === ticket.toLowerCase());
  }
  async requestedSince(opHash: string, since: Date) {
    return this.rows.find((r) => r.opHash === opHash.toLowerCase() && r.status === "requested" && r.createdAt > since);
  }
  async recent(limit: number, account?: string) {
    return this.rows.filter((r) => !account || r.account === account.toLowerCase()).slice(-limit).reverse();
  }
}
