// Exercises the Plynth stack on Robinhood Chain TESTNET (46630) through the contracts and the services running on
// this Mac (bash scripts/testnet/up.sh). Every send is chain-id guarded (lib.ts): nothing goes anywhere but 46630.
//
//   bun run scripts/testnet/exercise.ts                 instant areas now; time-bound steps are scheduled
//   bun run scripts/testnet/exercise.ts --resume        runs the scheduled steps that are due (re-run any time)
//   bun run scripts/testnet/exercise.ts --report-only   re-renders the report from the saved state (no sends)
//   bun run scripts/testnet/exercise.ts --recheck       re-verifies (read-only) failed steps listed in exercise/recheck.ts
//   ... --only area,area                                 (first form) only these areas
//
// State: app/.testnet/exercise-state.json. Report: app/.testnet/reports/testnet-run-<date>.md + .html, also copied
// into TESTNET_REPORT_DIR when set. Exit 0 only if every recorded step passed and no scheduled step failed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { assertTestnet, clients, log, PATHS, readDeployment, readLedger, role, RPC, TESTNET_CHAIN_ID, WALLETS, testers, type Role, type TestnetDeployment } from "./lib";
import { makeCtx, type TCtx } from "./exercise/ctx";
import { crowd, eligibility, network, perps, roundups, savings, timelocks, token, treasury } from "./exercise/areas";
import { HANDLERS } from "./exercise/scheduled";
import { applyOutcome, dueItems, emptyState, waiting, type ExerciseState } from "./exercise/state";
import { exitCode, renderHtml, renderMarkdown, type TestnetMeta } from "./exercise/report";
import { closeDb } from "./exercise/services";
import { recheck } from "./exercise/recheck";
import { summarize } from "../fork/exercise/report";

type Area = [name: string, fn: (x: TCtx) => Promise<void>];
export const AREAS: Area[] = [
  ["network", network],
  ["eligibility", eligibility],
  ["savings", savings],
  ["roundups", roundups],
  ["crowd", crowd],
  ["timelocks", timelocks],
  ["perps", perps],
  ["token", token],
  ["treasury", treasury],
];

function loadState(dep: TestnetDeployment): ExerciseState {
  const fresh = emptyState(TESTNET_CHAIN_ID, String(dep.savingsVault));
  if (!existsSync(PATHS.state)) return fresh;
  const s = JSON.parse(readFileSync(PATHS.state, "utf8")) as ExerciseState;
  if (s.deployment.toLowerCase() !== String(dep.savingsVault).toLowerCase()) {
    log("exercise state belongs to another deployment: starting a fresh one");
    return fresh;
  }
  return s;
}

function saveState(s: ExerciseState) {
  writeFileSync(PATHS.state, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function balances(s: ExerciseState): Promise<TestnetMeta["balances"]> {
  const addrs = (s.data.addresses ?? {}) as Record<string, string>;
  const out: TestnetMeta["balances"] = [];
  try {
    const { pub } = clients();
    for (const [r, a] of [...Object.entries(addrs), ...testers().map((t, i) => [`tester ${i + 1}`, t] as const)]) out.push({ role: r, address: a, wei: String(await pub.getBalance({ address: getAddress(a) })) });
  } catch (e) {
    log(`balances not read: ${(e as Error).message.split("\n")[0]}`);
  }
  return out;
}

async function writeReport(dep: TestnetDeployment, s: ExerciseState): Promise<{ md: string; code: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const deployment: Record<string, string> = {};
  for (const [k, v] of Object.entries(dep)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) deployment[k] = v;
  for (const [k, v] of Object.entries(dep.stocks)) deployment[`${k} token`] = v.token;
  for (const [k, v] of Object.entries((s.data.treasury ?? {}) as Record<string, string>)) deployment[`treasury ${k}`] = v;
  const meta: TestnetMeta = { date, generatedAt: new Date().toISOString(), rpc: RPC, chainId: TESTNET_CHAIN_ID, deployBlock: Number(dep.deployBlock), deployment, runs: s.runs, notes: [...new Set(s.notes)], balances: await balances(s) };
  const ledger = readLedger();
  mkdirSync(PATHS.reports, { recursive: true });
  const md = join(PATHS.reports, `testnet-run-${date}.md`);
  const html = join(PATHS.reports, `testnet-run-${date}.html`);
  writeFileSync(md, renderMarkdown(meta, s.steps, s.scheduled, ledger));
  writeFileSync(html, renderHtml(meta, s.steps, s.scheduled, ledger));
  const out = process.env.TESTNET_REPORT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    copyFileSync(md, join(out, `testnet-run-${date}.md`));
    copyFileSync(html, join(out, `testnet-run-${date}.html`));
  }
  for (const a of summarize(s.steps)) log(`${a.area.padEnd(12)} ${a.passed}/${a.steps} passed, ${a.failed + a.known} failed, ${a.txs} txs`);
  const now = Math.floor(Date.now() / 1000);
  for (const w of waiting(s, now)) log(`scheduled: ${w.id} due at ${new Date(w.dueAt * 1000).toISOString()}`);
  for (const f of s.scheduled.filter((x) => x.status === "failed")) log(`scheduled FAILED: ${f.id}: ${f.detail}`);
  const code = exitCode(s.steps, s.scheduled);
  log(`report ${md}${out ? ` (copied to ${out})` : ""}; exit ${code}`);
  return { md, code };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dep = readDeployment();
  if (!dep) throw new Error("no app/deployments/46630.json: run bash scripts/testnet/up.sh first");
  const s = loadState(dep);
  if (argv.includes("--report-only")) {
    if (!s.steps.length) throw new Error(`no exercise state in ${PATHS.state}: run the exercise first`);
    return (await writeReport(dep, s)).code;
  }
  await assertTestnet();
  if (argv.includes("--recheck")) {
    const x = makeCtx(dep, s);
    log(`${await recheck(x, log)} step(s) passed on re-check`);
    saveState(s);
    return (await writeReport(dep, s)).code;
  }
  s.data.addresses = Object.fromEntries((Object.keys(WALLETS) as Role[]).map((r) => [r, role(r).address]));
  const resume = argv.includes("--resume");
  const run = { mode: resume ? ("resume" as const) : ("run" as const), startedAt: new Date().toISOString() } as ExerciseState["runs"][number];
  s.runs.push(run);
  const x = makeCtx(dep, s);
  try {
    if (resume) {
      const now = Number(await x.r.now());
      const due = dueItems(s, now);
      log(`${due.length} scheduled step(s) due, ${waiting(s, now).length} waiting`);
      for (const item of due) {
        const h = HANDLERS[item.handler];
        x.r.area = item.area;
        log(`scheduled ${item.id}: ${item.title}`);
        if (!h) {
          applyOutcome(item, { status: "failed", detail: `no handler ${item.handler}` }, new Date().toISOString());
          continue;
        }
        try {
          applyOutcome(item, await h(x, item), new Date().toISOString());
        } catch (e) {
          x.r.abort(e);
          applyOutcome(item, { status: "failed", detail: (e as Error).message.split("\n")[0]! }, new Date().toISOString());
        }
        saveState(s);
      }
    } else {
      const arg = argv.find((a) => a.startsWith("--only"));
      const only = arg ? (arg.includes("=") ? arg.split("=")[1]! : argv[argv.indexOf(arg) + 1]!).split(",") : undefined;
      if (!only && s.runs.some((r) => r.mode === "run" && r.finishedAt) && process.env.TESTNET_ALLOW_RERUN !== "1") {
        throw new Error("this deployment was already exercised (deposits, books, treasury exist): use --resume, --only <area>, or TESTNET_ALLOW_RERUN=1");
      }
      for (const [name, fn] of AREAS) {
        if (only && !only.includes(name)) continue;
        x.r.area = name;
        log(`area ${name}`);
        try {
          await fn(x);
        } catch (e) {
          x.r.abort(e);
        }
        saveState(s);
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    saveState(s);
    await closeDb();
  }
  return (await writeReport(dep, s)).code;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`[testnet exercise] ${(e as Error).stack ?? e}`);
}
process.exit(code);
