// Exercises every transaction the Plynth stack supports on the running mainnet fork (bash scripts/fork/up.sh),
// through the contracts and through the running services (eligibility, API, indexer, keeper, relayer, MCP) and
// the treasury services' --once passes. Each step: send, wait for the receipt, assert the on-chain effect and,
// where a service shows it, the service's view after the indexer caught up. Negative cases must revert with the
// expected error.
//
//   bun run scripts/fork/exercise.ts [--only area,area]
//
// Writes app/.fork/results.json and app/.fork/reports/fork-run-<date>.md + .html (also into FORK_REPORT_DIR when
// set). Exits 0 only if every step passed or failed with a bug listed in exercise/known-bugs.ts.
//
// The run moves chain time (48h timelocks, crowd windows, treasury periods, unbonding), so it needs a fresh fork:
// bash scripts/fork/reset.sh && bash scripts/fork/up.sh first (FORK_ALLOW_RERUN=1 overrides, for debugging).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_CHAIN_ID, FORK_DIR, log, PATHS, readForkDeployment, waitForRpc } from "./lib";
import { Recorder } from "./exercise/core";
import { makeCtx, type Ctx } from "./exercise/context";
import { FIXED_BUGS, KNOWN_BUGS, OBSERVATIONS } from "./exercise/known-bugs";
import { exitCode, renderHtml, renderMarkdown, summarize } from "./exercise/report";
import { eligibility, savingsSetup } from "./exercise/consumer-setup";
import { crowd, quiet, spends, timelocks } from "./exercise/consumer-flow";
import { treasurySetup } from "./exercise/treasury-setup";
import { hidden } from "./exercise/hidden";
import { treasury } from "./exercise/treasury";
import { perps, perpsSetup } from "./exercise/perps";
import { issuer, token, unbonding } from "./exercise/token";
import { closeDb } from "./exercise/services";

type Area = [name: string, fn: (x: Ctx) => Promise<void>];

const AREAS: Area[] = [
  ["eligibility", eligibility],
  ["savings", savingsSetup],
  ["treasury-setup", treasurySetup],
  ["perps-setup", perpsSetup],
  ["timelocks", timelocks],
  ["spends", spends],
  ["crowd", crowd],
  ["quiet", quiet],
  ["hidden", hidden],
  ["treasury", treasury],
  ["perps", perps],
  ["token", token],
  ["issuer", issuer],
  ["unbonding", unbonding],
];

async function main(): Promise<number> {
  const arg = process.argv.find((a) => a.startsWith("--only"));
  const only = arg ? (arg.includes("=") ? arg.split("=")[1]! : process.argv[process.argv.indexOf(arg) + 1]!).split(",") : undefined;
  await waitForRpc();
  const dep = readForkDeployment();
  if (!dep) throw new Error("the fork has no deployment: run bash scripts/fork/up.sh first");
  if (existsSync(PATHS.exercised) && process.env.FORK_ALLOW_RERUN !== "1") {
    throw new Error("this fork was already exercised (time moved, books executed): bash scripts/fork/reset.sh && bash scripts/fork/up.sh, then run again");
  }
  writeFileSync(PATHS.exercised, new Date().toISOString());
  const r = new Recorder(new Map(), KNOWN_BUGS);
  const x = makeCtx(dep, r);
  const startedAt = new Date().toISOString();
  for (const [name, fn] of AREAS) {
    if (only && !only.includes(name)) continue;
    r.area = name;
    log(`area ${name}`);
    try {
      await fn(x);
    } catch (e) {
      r.abort(e);
    }
  }
  await closeDb();
  const finishedAt = new Date().toISOString();
  const date = finishedAt.slice(0, 10);
  const forkBlock = existsSync(PATHS.forkBlock) ? readFileSync(PATHS.forkBlock, "utf8").trim() : "unknown";
  const meta = {
    date,
    startedAt,
    finishedAt,
    forkBlock,
    forkSource: process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    chainId: FORK_CHAIN_ID,
    notes: [...x.notes, ...FIXED_BUGS.map((b) => `Fixed in this change: ${b}`), ...OBSERVATIONS.map((o) => `Observed: ${o}`)],
    diagnosis: x.diagnosis,
  };
  writeFileSync(PATHS.results, JSON.stringify({ meta, steps: r.steps }, null, 2));
  const dir = join(FORK_DIR, "reports");
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `fork-run-${date}.md`);
  const html = join(dir, `fork-run-${date}.html`);
  writeFileSync(md, renderMarkdown(meta, r.steps, KNOWN_BUGS));
  writeFileSync(html, renderHtml(meta, r.steps, KNOWN_BUGS));
  const out = process.env.FORK_REPORT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    copyFileSync(md, join(out, `fork-run-${date}.md`));
    copyFileSync(html, join(out, `fork-run-${date}.html`));
  }
  for (const a of summarize(r.steps)) log(`${a.area.padEnd(12)} ${a.passed}/${a.steps} passed, ${a.failed} failed, ${a.known} known, ${a.txs} txs`);
  const code = exitCode(r.steps);
  log(`report ${md}${out ? ` (copied to ${out})` : ""}; exit ${code}`);
  return code;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`[fork exercise] ${(e as Error).stack ?? e}`);
}
process.exit(code);
