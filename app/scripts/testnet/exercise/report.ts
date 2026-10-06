// Report of the testnet run: per-area summary, the scheduled steps (with when they are due), the gas ledger, every
// failure, and every step with its transaction linked to the testnet explorer. Markdown and a self-contained
// HTML page (no scripts, no remote assets).
import type { Step } from "../../fork/exercise/core";
import { exitCode as forkExitCode, summarize } from "../../fork/exercise/report";
import { fmtEth, ledgerTotals, txUrl, type LedgerEntry } from "../lib";
import { isoAt, type Scheduled } from "./state";

export type TestnetMeta = {
  date: string;
  generatedAt: string;
  rpc: string;
  chainId: number;
  deployBlock: number;
  deployment: Record<string, string>;
  runs: { mode: string; startedAt: string; finishedAt?: string | undefined }[];
  notes: string[];
  balances: { role: string; address: string; wei: string }[];
};

/** 0 when every recorded step passed and no scheduled step failed; 1 otherwise (and when nothing ran). */
export function exitCode(steps: Step[], scheduled: Scheduled[]): number {
  if (forkExitCode(steps) !== 0) return 1;
  return scheduled.some((s) => s.status === "failed") ? 1 : 0;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const mdTx = (h?: string) => (h ? `[${h.slice(0, 10)}…${h.slice(-6)}](${txUrl(h)})` : "");

export function renderMarkdown(meta: TestnetMeta, steps: Step[], scheduled: Scheduled[], ledger: LedgerEntry[]): string {
  const sum = summarize(steps);
  const passed = steps.filter((s) => s.status === "pass").length;
  const failed = steps.filter((s) => s.status !== "pass").length;
  const txs = steps.filter((s) => s.tx).length;
  const L: string[] = [];
  L.push(`# Testnet run ${meta.date}`, "");
  L.push(`Robinhood Chain **testnet** (chain id ${meta.chainId}, ${meta.rpc}). Stack deployed at L2 block ${meta.deployBlock}. Report generated ${meta.generatedAt}.`, "");
  L.push(`**${passed} passed, ${failed} failed** out of ${steps.length} steps (${txs} transactions). Scheduled: ${scheduled.filter((s) => s.status === "done").length} done, ${scheduled.filter((s) => s.status === "scheduled").length} waiting, ${scheduled.filter((s) => s.status === "failed").length} failed.`, "");
  L.push("Runs: " + meta.runs.map((r) => `${r.mode} ${r.startedAt}${r.finishedAt ? ` to ${r.finishedAt}` : ""}`).join("; "), "");
  for (const n of meta.notes) L.push(`- ${n}`);
  if (meta.notes.length) L.push("");
  L.push("## Summary by area", "", "| Area | Steps | Passed | Failed | Transactions | Gas used |", "|---|---:|---:|---:|---:|---:|");
  for (const a of sum) L.push(`| ${a.area} | ${a.steps} | ${a.passed} | ${a.failed + a.known} | ${a.txs} | ${a.gas.toLocaleString("en-US")} |`);
  L.push("");
  L.push("## Scheduled (waits on real time; `bun run scripts/testnet/exercise.ts --resume` completes the due ones)", "", "| Step | Area | Due (UTC) | Status | Detail |", "|---|---|---|---|---|");
  for (const s of [...scheduled].sort((a, b) => a.dueAt - b.dueAt)) L.push(`| ${cell(s.title)} | ${s.area} | ${isoAt(s.dueAt)} | ${s.status === "scheduled" ? `scheduled: due at ${isoAt(s.dueAt)}` : s.status}${s.doneAt ? ` (${s.doneAt})` : ""} | ${cell(s.detail ?? "")} |`);
  L.push("");
  L.push("## Gas ledger (testnet ETH)", "");
  const tot = ledgerTotals(ledger);
  L.push("| Sender | Transactions | Fees (ETH) | ETH sent (ETH) |", "|---|---:|---:|---:|");
  for (const [k, v] of Object.entries(tot)) L.push(`| ${k} | ${v.txs} | ${fmtEth(v.fees)} | ${fmtEth(v.sent)} |`);
  const stepGas = steps.reduce((g, s) => g + BigInt(s.gas ?? "0"), 0n);
  L.push("", `Exercise steps used ${stepGas.toLocaleString("en-US")} gas in ${txs} transactions (at 0.01 gwei: ${fmtEth(stepGas * 10_000_000n)} ETH plus L1 data fees).`, "");
  L.push("Balances now:", "", "| Role | Address | ETH |", "|---|---|---:|");
  for (const b of meta.balances) L.push(`| ${b.role} | \`${b.address}\` | ${fmtEth(BigInt(b.wei))} |`);
  L.push("");
  const bad = steps.filter((s) => s.status !== "pass");
  L.push("## Failures", "");
  if (!bad.length) L.push("None.", "");
  for (const s of bad) L.push(`### ${s.area}: ${s.step}`, "", `- Actor: ${s.actor}${s.tx ? `, tx ${mdTx(s.tx)}` : ""}`, `- Expected: ${s.assertion}`, `- Got: ${s.detail ?? "-"}`, "");
  L.push("## Deployment (app/deployments/46630.json)", "", "| Name | Address |", "|---|---|");
  for (const [k, v] of Object.entries(meta.deployment)) L.push(`| ${k} | \`${v}\` |`);
  L.push("");
  L.push("## Every step", "", "| # | Area | Step | Actor | Tx | Gas | Status | Assertion |", "|---:|---|---|---|---|---:|---|---|");
  steps.forEach((s, i) => L.push(`| ${i + 1} | ${s.area} | ${cell(s.step)} | ${cell(s.actor)} | ${mdTx(s.tx)} | ${s.gas ?? ""} | ${s.status === "pass" ? "pass" : "FAIL"} | ${cell(s.status === "pass" ? s.assertion : `${s.assertion}: ${s.detail ?? ""}`)} |`));
  L.push("");
  return L.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const htmlTx = (h?: string) => (h ? `<a class="m" href="${esc(txUrl(h))}">${esc(`${h.slice(0, 10)}…${h.slice(-6)}`)}</a>` : "");

export function renderHtml(meta: TestnetMeta, steps: Step[], scheduled: Scheduled[], ledger: LedgerEntry[]): string {
  const sum = summarize(steps);
  const passed = steps.filter((s) => s.status === "pass").length;
  const failed = steps.length - passed;
  const badge = (s: Step) => (s.status === "pass" ? `<span class="b ok">pass</span>` : `<span class="b no">FAIL</span>`);
  const sbadge = (s: Scheduled) => (s.status === "done" ? `<span class="b ok">done</span>` : s.status === "failed" ? `<span class="b no">failed</span>` : `<span class="b kn">scheduled: due at ${esc(isoAt(s.dueAt))}</span>`);
  const rows = steps.map((s, i) => `<tr><td class="n">${i + 1}</td><td>${esc(s.area)}</td><td>${esc(s.step)}</td><td>${esc(s.actor)}</td><td>${htmlTx(s.tx)}</td><td class="n">${s.gas ? Number(s.gas).toLocaleString("en-US") : ""}</td><td>${badge(s)}</td><td>${esc(s.status === "pass" ? s.assertion : `${s.assertion}: ${s.detail ?? ""}`)}</td></tr>`).join("\n");
  const sched = [...scheduled].sort((a, b) => a.dueAt - b.dueAt).map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.area)}</td><td class="m">${esc(isoAt(s.dueAt))}</td><td>${sbadge(s)}</td><td>${esc(s.detail ?? "")}</td></tr>`).join("\n");
  const tot = ledgerTotals(ledger);
  const ledgerRows = Object.entries(tot).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.txs}</td><td class="n">${fmtEth(v.fees)}</td><td class="n">${fmtEth(v.sent)}</td></tr>`).join("\n");
  const bal = meta.balances.map((b) => `<tr><td>${esc(b.role)}</td><td class="m">${esc(b.address)}</td><td class="n">${fmtEth(BigInt(b.wei))}</td></tr>`).join("\n");
  const fails = steps.filter((s) => s.status !== "pass").map((s) => `<div class="card"><h3>${esc(s.area)}: ${esc(s.step)} ${badge(s)}</h3><p><b>Expected</b> ${esc(s.assertion)}</p><p><b>Got</b> ${esc(s.detail ?? "-")}</p>${s.tx ? `<p>${htmlTx(s.tx)}</p>` : ""}</div>`).join("\n");
  const depRows = Object.entries(meta.deployment).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="m">${esc(v)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Testnet run ${esc(meta.date)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1d1f;--mut:#62666d;--line:#e3e3e0;--card:#fff;--ok:#1d7a46;--okb:#e3f3ea;--no:#b42318;--nob:#fde8e6;--kn:#8a5a00;--knb:#fdf1d8;--link:#1d5bbf}
@media (prefers-color-scheme: dark){:root{--bg:#141517;--fg:#e8e8e6;--mut:#a0a4ab;--line:#2c2e33;--card:#1b1c1f;--ok:#5fd394;--okb:#123222;--no:#ff8a7a;--nob:#3a1612;--kn:#f2c063;--knb:#33270c;--link:#8ab4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px}h3{font-size:15px;margin:0 0 6px}
a{color:var(--link)}.mut{color:var(--mut)}.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:120px}
.kpi b{display:block;font-size:24px}.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--card)}
td.n{text-align:right;font-variant-numeric:tabular-nums}.m{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.b{display:inline-block;border-radius:999px;padding:0 8px;font-size:12px;font-weight:600}.ok{color:var(--ok);background:var(--okb)}.no{color:var(--no);background:var(--nob)}.kn{color:var(--kn);background:var(--knb)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:10px 0}.card p{margin:4px 0}
</style></head><body><main>
<h1>Testnet run ${esc(meta.date)}</h1>
<p class="mut">Robinhood Chain testnet, chain id ${meta.chainId} (${esc(meta.rpc)}), stack deployed at L2 block ${meta.deployBlock}. Generated ${esc(meta.generatedAt)}. Every transaction links to the testnet explorer.</p>
<div class="kpis"><div class="kpi"><span class="mut">Steps</span><b>${steps.length}</b></div><div class="kpi"><span class="mut">Passed</span><b>${passed}</b></div><div class="kpi"><span class="mut">Failed</span><b>${failed}</b></div><div class="kpi"><span class="mut">Transactions</span><b>${steps.filter((s) => s.tx).length}</b></div><div class="kpi"><span class="mut">Scheduled waiting</span><b>${scheduled.filter((s) => s.status === "scheduled").length}</b></div></div>
${meta.notes.length ? `<ul>${meta.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
<h2>Summary by area</h2>
<div class="wrap"><table><thead><tr><th>Area</th><th>Steps</th><th>Passed</th><th>Failed</th><th>Txs</th><th>Gas used</th></tr></thead><tbody>
${sum.map((a) => `<tr><td>${esc(a.area)}</td><td class="n">${a.steps}</td><td class="n">${a.passed}</td><td class="n">${a.failed + a.known}</td><td class="n">${a.txs}</td><td class="n">${a.gas.toLocaleString("en-US")}</td></tr>`).join("\n")}
</tbody></table></div>
<h2>Scheduled</h2>
<p class="mut">Testnet has no time travel. These wait on real time; <code>bun run scripts/testnet/exercise.ts --resume</code> completes the due ones.</p>
<div class="wrap"><table><thead><tr><th>Step</th><th>Area</th><th>Due (UTC)</th><th>Status</th><th>Detail</th></tr></thead><tbody>
${sched}
</tbody></table></div>
<h2>Gas ledger</h2>
<div class="wrap"><table><thead><tr><th>Sender</th><th>Txs</th><th>Fees (ETH)</th><th>ETH sent</th></tr></thead><tbody>
${ledgerRows}
</tbody></table></div>
<h2>Balances</h2>
<div class="wrap"><table><thead><tr><th>Role</th><th>Address</th><th>ETH</th></tr></thead><tbody>
${bal}
</tbody></table></div>
<h2>Failures</h2>${fails || `<p class="mut">None.</p>`}
<h2>Every step</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Area</th><th>Step</th><th>Actor</th><th>Tx</th><th>Gas</th><th>Status</th><th>Assertion</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<h2>Deployment</h2>
<div class="wrap"><table><thead><tr><th>Name</th><th>Address</th></tr></thead><tbody>
${depRows}
</tbody></table></div>
</main></body></html>
`;
}
