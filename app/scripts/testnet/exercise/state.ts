// Persistent state of the testnet exercise (app/.testnet/exercise-state.json). Testnet has no time travel, so a
// run records the steps that ran now and SCHEDULES the ones that wait on real time (crowd window + beacon jitter,
// 48h timelocks, the 24h LP cooldown, 7-day unbonding). `exercise.ts --resume` runs the scheduled steps that are
// due and keeps the rest. Pure functions here; the file I/O is in exercise.ts.
import type { Step } from "../../fork/exercise/core";

export type ScheduledStatus = "scheduled" | "done" | "failed";

export type Scheduled = {
  /** Handler id (exercise/scheduled.ts) plus a suffix when one handler is scheduled more than once. */
  id: string;
  handler: string;
  area: string;
  title: string;
  /** Unix seconds (chain time) when it may run. */
  dueAt: number;
  status: ScheduledStatus;
  detail?: string | undefined;
  doneAt?: string | undefined;
  /** Handler arguments (addresses, book ids). */
  args?: Record<string, unknown> | undefined;
};

export type RunRecord = { mode: "run" | "resume"; startedAt: string; finishedAt?: string | undefined };

export type ExerciseState = {
  version: 1;
  chainId: number;
  /** savingsVault of the deployment this state belongs to: a redeploy starts a fresh state. */
  deployment: string;
  runs: RunRecord[];
  steps: Step[];
  scheduled: Scheduled[];
  /** Cross-area and cross-run hand-offs (treasury addresses, book ids, policy hash). JSON only. */
  data: Record<string, any>;
  notes: string[];
};

export function emptyState(chainId: number, deployment: string): ExerciseState {
  return { version: 1, chainId, deployment, runs: [], steps: [], scheduled: [], data: {}, notes: [] };
}

/** Adds a scheduled step, or updates the one with the same id that has not run yet (a done one is kept). */
export function schedule(s: ExerciseState, item: Omit<Scheduled, "status"> & { status?: ScheduledStatus }): Scheduled {
  const existing = s.scheduled.find((x) => x.id === item.id);
  if (existing) {
    if (existing.status === "done") return existing;
    Object.assign(existing, { ...item, status: item.status ?? "scheduled" });
    return existing;
  }
  const next: Scheduled = { ...item, status: item.status ?? "scheduled" };
  s.scheduled.push(next);
  return next;
}

/** The scheduled steps that may run at `now` (unix seconds), earliest first. Failed ones are retried. */
export function dueItems(s: ExerciseState, now: number): Scheduled[] {
  return s.scheduled.filter((x) => x.status !== "done" && x.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** The ones still waiting, earliest first. */
export function waiting(s: ExerciseState, now: number): Scheduled[] {
  return s.scheduled.filter((x) => x.status !== "done" && x.dueAt > now).sort((a, b) => a.dueAt - b.dueAt);
}

/** What a handler returns: done, not yet (run again at `dueAt`), or failed (kept and retried on the next resume). */
export type Outcome = { status: "done"; detail?: string } | { status: "later"; dueAt: number; detail?: string } | { status: "failed"; detail: string };

export function applyOutcome(item: Scheduled, o: Outcome, nowIso: string): void {
  if (o.status === "done") {
    item.status = "done";
    item.doneAt = nowIso;
    item.detail = o.detail;
  } else if (o.status === "later") {
    item.status = "scheduled";
    item.dueAt = o.dueAt;
    item.detail = o.detail;
  } else {
    item.status = "failed";
    item.detail = o.detail;
  }
}

export const isoAt = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");
