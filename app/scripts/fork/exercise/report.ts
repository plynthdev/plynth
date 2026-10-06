// Report of a fork run: per-area summary, every step with its transaction, every failure with its revert reason,
// and the known bugs with repro and diagnosis. Markdown and a self-contained HTML page (no scripts, no remote
// assets).
import type { Step } from "./core";
import type { KnownBug } from "./known-bugs";

export type RunMeta = {
  date: string; // YYYY-MM-DD
  startedAt: string;
  finishedAt: string;
  forkBlock: string;
  forkSource: string;
  chainId: number;
  /** Extra notes (skips, environment). */
  notes: string[];
  /** Free-text diagnosis per failed step key (area/step), added by the run itself where it knows the cause. */
  diagnosis?: Record<string, string>;
};

export type AreaSummary = { area: string; steps: number; passed: number; failed: number; known: number; txs: number; gas: bigint };

export function summarize(steps: Step[]): AreaSummary[] {
  const out = new Map<string, AreaSummary>();
  for (const s of steps) {
    const a = out.get(s.area) ?? { area: s.area, steps: 0, passed: 0, failed: 0, known: 0, txs: 0, gas: 0n };
    a.steps++;
    if (s.status === "pass") a.passed++;
    else if (s.status === "fail") a.failed++;
    else a.known++;
    if (s.tx) a.txs++;
    if (s.gas) a.gas += BigInt(s.gas);
    out.set(s.area, a);
  }
  return [...out.values()];
}

/** 0 when every step passed or failed with a known bug; 1 otherwise (and when nothing ran). */
export function exitCode(steps: Step[]): number {
  if (steps.length === 0) return 1;
  return steps.some((s) => s.status === "fail") ? 1 : 0;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(meta: RunMeta, steps: Step[], bugs: KnownBug[]): string {
  const sum = summarize(steps);
  const tot = sum.reduce((t, a) => ({ steps: t.steps + a.steps, passed: t.passed + a.passed, failed: t.failed + a.failed, known: t.known + a.known, txs: t.txs + a.txs }), { steps: 0, passed: 0, failed: 0, known: 0, txs: 0 });
  const used = new Set(steps.filter((s) => s.bug).map((s) => s.bug));
  const L: string[] = [];
  L.push(`# Mainnet fork run ${meta.date}`, "");
  L.push(`Anvil fork of Robinhood Chain mainnet (${meta.forkSource}) at block ${meta.forkBlock}, run as chain id ${meta.chainId}. Started ${meta.startedAt}, finished ${meta.finishedAt}.`, "");
  L.push(`**${tot.passed} passed, ${tot.failed} failed, ${tot.known} known bugs** out of ${tot.steps} steps (${tot.txs} transactions).`, "");
  for (const n of meta.notes) L.push(`- ${n}`);
  if (meta.notes.length) L.push("");
  L.push("## Summary by area", "", "| Area | Steps | Passed | Failed | Known bug | Transactions | Gas used |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const a of sum) L.push(`| ${a.area} | ${a.steps} | ${a.passed} | ${a.failed} | ${a.known} | ${a.txs} | ${a.gas.toLocaleString("en-US")} |`);
  L.push("");
  const bad = steps.filter((s) => s.status !== "pass");
  L.push("## Failures", "");
  if (!bad.length) L.push("None.", "");
  for (const s of bad) {
    const key = `${s.area}/${s.step}`;
    const bug = bugs.find((b) => b.id === s.bug);
    L.push(`### ${s.area}: ${s.step}`, "");
    L.push(`- Status: ${s.status === "known" ? `known bug ${s.bug}` : "FAILED"}`);
    L.push(`- Actor: ${s.actor}${s.tx ? `, tx ${s.tx}` : ""}`);
    L.push(`- Expected: ${s.assertion}`);
    L.push(`- Got: ${s.detail ?? "-"}`);
    const d = bug?.diagnosis ?? meta.diagnosis?.[key];
    if (d) L.push(`- Diagnosis: ${d}`);
    L.push("");
  }
  L.push("## Bugs found", "");
  const listed = bugs.filter((b) => used.has(b.id));
  if (!listed.length) L.push("None.", "");
  for (const b of listed) L.push(`### ${b.id}: ${b.title}`, "", `- Repro: ${b.repro}`, `- Diagnosis: ${b.diagnosis}`, "");
  L.push("## Every step", "", "| # | Area | Step | Actor | Tx | Gas | Status | Assertion |", "|---:|---|---|---|---|---:|---|---|");
  steps.forEach((s, i) => {
    L.push(`| ${i + 1} | ${s.area} | ${cell(s.step)} | ${cell(s.actor)} | ${s.tx ? `\`${s.tx}\`` : ""} | ${s.gas ?? ""} | ${s.status === "pass" ? "pass" : s.status === "known" ? `known ${s.bug}` : "FAIL"} | ${cell(s.status === "pass" ? s.assertion : `${s.assertion}: ${s.detail ?? ""}`)} |`);
  });
  L.push("");
  return L.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderHtml(meta: RunMeta, steps: Step[], bugs: KnownBug[]): string {
  const sum = summarize(steps);
  const passed = steps.filter((s) => s.status === "pass").length;
  const failed = steps.filter((s) => s.status === "fail").length;
  const known = steps.filter((s) => s.status === "known").length;
  const used = new Set(steps.filter((s) => s.bug).map((s) => s.bug));
  const bad = steps.filter((s) => s.status !== "pass");
  const badge = (s: Step) => (s.status === "pass" ? `<span class="b ok">pass</span>` : s.status === "known" ? `<span class="b kn">known ${esc(s.bug ?? "")}</span>` : `<span class="b no">FAIL</span>`);
  const rows = steps
    .map(
      (s, i) =>
        `<tr><td class="n">${i + 1}</td><td>${esc(s.area)}</td><td>${esc(s.step)}</td><td>${esc(s.actor)}</td><td class="m">${s.tx ? esc(`${s.tx.slice(0, 10)}…${s.tx.slice(-6)}`) : ""}</td><td class="n">${s.gas ? Number(s.gas).toLocaleString("en-US") : ""}</td><td>${badge(s)}</td><td>${esc(s.status === "pass" ? s.assertion : `${s.assertion}: ${s.detail ?? ""}`)}</td></tr>`,
    )
    .join("\n");
  const fails = bad
    .map((s) => {
      const bug = bugs.find((b) => b.id === s.bug);
      const d = bug?.diagnosis ?? meta.diagnosis?.[`${s.area}/${s.step}`];
      return `<div class="card"><h3>${esc(s.area)}: ${esc(s.step)} ${badge(s)}</h3><p><b>Expected</b> ${esc(s.assertion)}</p><p><b>Got</b> ${esc(s.detail ?? "-")}</p>${s.tx ? `<p class="m">${esc(s.tx)}</p>` : ""}${d ? `<p><b>Diagnosis</b> ${esc(d)}</p>` : ""}</div>`;
    })
    .join("\n");
  const bugCards = bugs
    .filter((b) => used.has(b.id))
    .map((b) => `<div class="card"><h3>${esc(b.id)}: ${esc(b.title)}</h3><p><b>Repro</b> ${esc(b.repro)}</p><p><b>Diagnosis</b> ${esc(b.diagnosis)}</p></div>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fork run ${esc(meta.date)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1d1f;--mut:#62666d;--line:#e3e3e0;--card:#fff;--ok:#1d7a46;--okb:#e3f3ea;--no:#b42318;--nob:#fde8e6;--kn:#8a5a00;--knb:#fdf1d8}
@media (prefers-color-scheme: dark){:root{--bg:#141517;--fg:#e8e8e6;--mut:#a0a4ab;--line:#2c2e33;--card:#1b1c1f;--ok:#5fd394;--okb:#123222;--no:#ff8a7a;--nob:#3a1612;--kn:#f2c063;--knb:#33270c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px}h3{font-size:15px;margin:0 0 6px}
.mut{color:var(--mut)}.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:120px}
.kpi b{display:block;font-size:24px}.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--card)}
td.n{text-align:right;font-variant-numeric:tabular-nums}.m{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.b{display:inline-block;border-radius:999px;padding:0 8px;font-size:12px;font-weight:600;white-space:nowrap}.ok{color:var(--ok);background:var(--okb)}.no{color:var(--no);background:var(--nob)}.kn{color:var(--kn);background:var(--knb)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:10px 0}.card p{margin:4px 0}
</style></head><body><main>
<h1>Mainnet fork run ${esc(meta.date)}</h1>
<p class="mut">Anvil fork of Robinhood Chain mainnet (${esc(meta.forkSource)}) at block ${esc(meta.forkBlock)}, chain id ${meta.chainId}. ${esc(meta.startedAt)} to ${esc(meta.finishedAt)}.</p>
<div class="kpis"><div class="kpi"><span class="mut">Steps</span><b>${steps.length}</b></div><div class="kpi"><span class="mut">Passed</span><b>${passed}</b></div><div class="kpi"><span class="mut">Failed</span><b>${failed}</b></div><div class="kpi"><span class="mut">Known bugs</span><b>${known}</b></div><div class="kpi"><span class="mut">Transactions</span><b>${steps.filter((s) => s.tx).length}</b></div></div>
${meta.notes.length ? `<ul>${meta.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
<h2>Summary by area</h2>
<div class="wrap"><table><thead><tr><th>Area</th><th>Steps</th><th>Passed</th><th>Failed</th><th>Known</th><th>Txs</th><th>Gas used</th></tr></thead><tbody>
${sum.map((a) => `<tr><td>${esc(a.area)}</td><td class="n">${a.steps}</td><td class="n">${a.passed}</td><td class="n">${a.failed}</td><td class="n">${a.known}</td><td class="n">${a.txs}</td><td class="n">${a.gas.toLocaleString("en-US")}</td></tr>`).join("\n")}
</tbody></table></div>
<h2>Failures</h2>${fails || `<p class="mut">None.</p>`}
<h2>Bugs found</h2>${bugCards || `<p class="mut">None.</p>`}
<h2>Every step</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Area</th><th>Step</th><th>Actor</th><th>Tx</th><th>Gas</th><th>Status</th><th>Assertion</th></tr></thead><tbody>
${rows}
</tbody></table></div>
</main></body></html>
`;
}
