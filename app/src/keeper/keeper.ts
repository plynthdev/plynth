import type { Ctx, JobResult } from "./context";
import { runBeacon } from "./jobs/beacon";
import { runExecute } from "./jobs/execute";
import { runLiquidate } from "./jobs/liquidate";
import { runPerpPoke } from "./jobs/perp-poke";
import { runFeePush } from "./jobs/fee-push";
import { runDeliverHidden } from "./jobs/hidden";
import { runRefreshMockFeeds } from "./jobs/mock-feeds";
import { runDeliverQuiet } from "./jobs/quiet";
import { runRoundups } from "./jobs/roundups";
import { runSpends } from "./jobs/spends";
import { runSweep } from "./jobs/sweep";
import { runTopups } from "./jobs/topups";

/**
 * Pass order matters within one pass: refresh-mock-feeds first (testnet kit only), so a mock feed that went stale
 * cannot put the market on hold for this pass's execute. liquidate next: a safety job (perp positions below
 * maintenance, bad debt, settling markets held past their grace), so a slow or failing consumer job never delays it.
 * perp-poke right after it records a recent price on perp markets that have not traded for an hour, so a later
 * delisting starts its grace from a recent price (only when the feed has something newer: no gas while closed).
 * Then top-ups fund `available`, on-chain round-ups move it to `pending`, sweep
 * joins pending into books, beacon commits for books that now exist, execute runs books whose time came.
 * deliver-open needs nothing from the keeper: users claim (claimOpen). deliver-quiet runs last: it delivers
 * books executed in earlier passes (it reads executions from the indexer). deliver-hidden (after it) settles Hidden users
 * into ShieldedPool notes and batches ready pending deposits into the tree. fee-push (independent of the consumer
 * jobs, right after the feed refresh) observes the PLTH pool and pushes the FeeRouter hourly: push is keeper-only.
 * spends (statement / Plaid accruals) runs LAST (audit M-7): those rows come from user uploads, so whatever they
 * cost in time or gas can never hold up sweep, beacon, execute or delivery; their accruals sweep on the next pass.
 */
export const JOBS: [string, (ctx: Ctx) => Promise<JobResult>][] = [
  ["refresh-mock-feeds", runRefreshMockFeeds],
  ["liquidate", runLiquidate],
  ["perp-poke", runPerpPoke],
  ["fee-push", runFeePush],
  ["topups", runTopups],
  ["roundups", runRoundups],
  ["sweep", runSweep],
  ["beacon", runBeacon],
  ["execute", runExecute],
  ["deliver-quiet", runDeliverQuiet],
  ["deliver-hidden", runDeliverHidden],
  ["spends", runSpends],
];

export type PassReport = { at: string; ok: boolean; jobs: JobResult[] };

/** One pass over every job. A failing job is reported and does not stop the others. */
export async function runPass(ctx: Ctx, jobs = JOBS): Promise<PassReport> {
  const out: JobResult[] = [];
  for (const [name, fn] of jobs) {
    try {
      out.push(await fn(ctx));
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).split("\n")[0]!;
      ctx.log(`${name} failed: ${msg}`);
      out.push({ job: name, ok: false, actions: 0, notes: [], error: msg });
    }
  }
  return { at: new Date().toISOString(), ok: out.every((j) => j.ok), jobs: out };
}
