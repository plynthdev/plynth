import type { Ctx, JobResult } from "./context";
import { runBeacon } from "./jobs/beacon";
import { runExecute } from "./jobs/execute";
import { runDeliverHidden } from "./jobs/hidden";
import { runRefreshMockFeeds } from "./jobs/mock-feeds";
import { runDeliverQuiet } from "./jobs/quiet";
import { runRoundups } from "./jobs/roundups";
import { runSpends } from "./jobs/spends";
import { runSweep } from "./jobs/sweep";
import { runTopups } from "./jobs/topups";

/**
 * Pass order matters within one pass: refresh-mock-feeds first (testnet kit only), so a mock feed that went stale
 * cannot put the market on hold for this pass's execute. Then top-ups fund `available`, round-ups (on-chain, then statement/Plaid
 * spends) move it to `pending`, sweep
 * joins pending into books, beacon commits for books that now exist, execute runs books whose time came.
 * deliver-open needs nothing from the keeper: users claim (claimOpen). deliver-quiet runs last: it delivers
 * books executed in earlier passes (it reads executions from the indexer). deliver-hidden (after it) settles Hidden users
 * into ShieldedPool notes and batches ready pending deposits into the tree.
 */
export const JOBS: [string, (ctx: Ctx) => Promise<JobResult>][] = [
  ["refresh-mock-feeds", runRefreshMockFeeds],
  ["topups", runTopups],
  ["roundups", runRoundups],
  ["spends", runSpends],
  ["sweep", runSweep],
  ["beacon", runBeacon],
  ["execute", runExecute],
  ["deliver-quiet", runDeliverQuiet],
  ["deliver-hidden", runDeliverHidden],
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
