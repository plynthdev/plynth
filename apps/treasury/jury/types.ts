// What the jury sees and what it returns. Every USD amount is 1e18-scaled and every token amount is in raw
// units, both as decimal strings, so the request and the bundle are plain JSON and hash the same everywhere.
import type { Hex } from "viem";

export type Recommend = "approve" | "reject";
export type Band = { minBps: number; maxBps: number };

export type ExceptionRequest = {
  chainId: number;
  account: string;
  approvals: string;
  desk: string;
  opHash: Hex;
  /** The decoded operation the desk wants to run. */
  intent: { action: string; asset: string; amount: string; notionalUsd: string; note?: string };
  /** The policy in force (the fields the guard checks). Whole USD for caps, like TreasuryPolicy. */
  policy: {
    hash?: string;
    version?: number;
    cash: Band;
    equity: Band;
    perOrderCapUsd: string;
    perDayCapUsd: string;
    approvalAboveUsd: string;
    noNewRiskOffHours: boolean;
    pauseNewRiskAtDrawdownBps: number;
    deriskAtDrawdownBps: number;
  };
  /** Current book (PolicyGuard.snapshot): NAV and the cash / equity buckets. */
  weights: { navUsd: string; cashUsd: string; equityUsd: string };
  /** Why it is an exception: the guard's reason code and name (11 = R9_APPROVAL). */
  guard: { code: number | null; reason: string };
  market: {
    timestamp: number;
    equityHold: boolean; // a held Stock Token's feed is stale (markets closed / feed on hold)
    dayUsedUsd: string; // notional already traded in the guard's 24h window
    periodStartNavUsd: string; // 0 = no PeriodClose yet
  };
};

export type RuleCheck = { rule: string; ok: boolean; detail: string };

export type RuleOpinion = {
  juror: "rules";
  recommend: Recommend;
  confidence: 1;
  reasons: string[];
  needsTicket: boolean;
  checks: RuleCheck[];
  projected: { navUsd: string; cashBpsBefore: number; cashBpsAfter: number; equityBpsBefore: number; equityBpsAfter: number; drawdownBps: number | null };
};

export type JurorVote = { model: string; status: "vote"; recommend: Recommend; confidence: number; reasons: string[]; attempts: number };
export type JurorAbstain = { model: string; status: "abstain"; error: string; attempts: number };
export type JurorResult = JurorVote | JurorAbstain;

export type Verdict = { recommend: Recommend | "none"; approve: number; reject: number; abstain: number; why: string };

export const JURY_SCHEMA = "plynth.jury.bundle/1";

export type JuryBundle = {
  schema: typeof JURY_SCHEMA;
  mode: "models+rules" | "rules-only";
  createdAt: string;
  request: ExceptionRequest;
  models: string[];
  jurors: JurorResult[];
  verdict: Verdict;
  rules: RuleOpinion;
  note: string;
};
