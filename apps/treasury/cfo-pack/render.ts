// Renders a verified Statement (on-chain event + matching bundle) as JSON, CSV and one self-contained HTML
// page (inline CSS, no scripts, no external requests). Takes only a Statement: nothing else is read.
import { formatUnits } from "viem";
import type { Statement } from "./verify";

const usd = (x: string | bigint, dp = 2) => {
  const s = formatUnits(BigInt(x), 18);
  const [i, f = ""] = s.split(".");
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dp === 0 ? grouped : `${grouped}.${(f + "0".repeat(dp)).slice(0, dp)}`;
};
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const iso = (ts: number | bigint) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
const KIND = ["cash", "cash vault", "stock token"];
const BAND = ["cash", "equity"];

export function toJson(s: Statement) {
  const { event: e, bundle: b } = s;
  return {
    statement: {
      chainId: e.chainId,
      periodClose: e.periodClose,
      account: b.account,
      index: e.index,
      periodStart: iso(b.periodStart),
      periodEnd: iso(e.close.periodEnd),
      navUsd: e.close.navUsd.toString(),
      cashBps: e.close.cashBps,
      equityBps: e.close.equityBps,
      policy: { hash: e.close.policyHash, version: e.close.policyVersion },
      positionsHash: e.close.positionsHash,
      bundleHash: e.close.bundleHash,
      fee: { raw: e.feeRaw.toString(), paid: e.feePaid.toString(), owed: e.feeOwed.toString(), bps: b.fee.bps, recipient: b.fee.recipient },
      tx: { hash: e.txHash, block: e.blockNumber.toString() },
    },
    positions: b.positions,
    deskActions: b.deskActions,
    guardDenials: b.guardDenials,
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per position, then the statement totals. */
export function toCsv(s: Statement): string {
  const head = ["asset", "symbol", "kind", "band", "decimals", "raw", "price_usd_1e18", "multiplier_1e18", "round_id", "value_usd_1e18", "weight_bps"];
  const rows = s.bundle.positions.map((p) => [p.asset, p.symbol, KIND[p.kind] ?? p.kind, BAND[p.band] ?? p.band, p.decimals, p.raw, p.price, p.multiplier, p.roundId, p.usd, p.weightBps]);
  const c = s.event.close;
  const totals = [
    ["nav_usd_1e18", c.navUsd.toString()],
    ["cash_bps", c.cashBps],
    ["equity_bps", c.equityBps],
    ["period_end", iso(c.periodEnd)],
    ["positions_hash", c.positionsHash],
    ["bundle_hash", c.bundleHash],
    ["policy_hash", c.policyHash],
    ["policy_version", c.policyVersion],
    ["fee_paid_raw", s.event.feePaid.toString()],
    ["fee_owed_raw", s.event.feeOwed.toString()],
    ["tx_hash", s.event.txHash],
  ];
  return [head, ...rows, [], ...totals].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function toHtml(s: Statement): string {
  const { event: e, bundle: b } = s;
  const c = e.close;
  const posRows = b.positions
    .map(
      (p) =>
        `<tr><td>${esc(p.symbol || p.asset)}</td><td class="mono">${esc(p.asset)}</td><td>${esc(KIND[p.kind] ?? p.kind)}</td><td class="n">${esc(formatUnits(BigInt(p.raw), p.decimals))}</td><td class="n">$${esc(usd(p.price, 4))}</td><td class="n">${esc(p.roundId)}</td><td class="n">$${esc(usd(p.usd))}</td><td class="n">${esc(pct(p.weightBps))}</td></tr>`,
    )
    .join("");
  const actRows = (xs: typeof b.deskActions) =>
    xs.length
      ? xs.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.desk)}</td><td>${esc(a.action)}</td><td>${esc(a.status)}</td><td>${esc(a.reason ?? "")}</td><td class="mono">${esc(a.txHash ?? "")}</td></tr>`).join("")
      : `<tr><td colspan="6" class="muted">None in this period.</td></tr>`;
  const kv = (k: string, v: string, mono = false) => `<div class="kv"><span>${esc(k)}</span><span${mono ? ' class="mono"' : ""}>${esc(v)}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Period statement #${e.index}</title>
<style>
:root{--bg:#fff;--fg:#14161a;--muted:#5d6470;--line:#e3e6ea;--accent:#1f6f50}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--muted:#9aa1ab;--line:#2a2e34;--accent:#5cc49a}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px 16px}
main{max-width:1000px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.nav{font-size:32px;font-weight:600;color:var(--accent);margin:16px 0 4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:4px 24px}
.kv{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:4px 0}.kv span:first-child{color:var(--muted)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
footer{margin-top:32px;font-size:12px}
</style></head><body><main>
<h1>Period statement #${e.index}</h1>
<div class="muted">${esc(iso(b.periodStart))} to ${esc(iso(c.periodEnd))} · chain ${e.chainId}</div>
<div class="nav">$${esc(usd(c.navUsd))}</div>
<div class="muted">Net asset value, recomputed on-chain from holdings at commit.</div>
<h2>Summary</h2>
<div class="grid">
${kv("Cash weight", pct(c.cashBps))}${kv("Equity weight", pct(c.equityBps))}
${kv("Policy version", String(c.policyVersion))}${kv("Platform fee paid (raw)", e.feePaid.toString())}
${kv("Fee owed carried (raw)", e.feeOwed.toString())}${kv("Guard denials", String(b.guardDenials.length))}
</div>
<h2>Positions</h2>
<div class="wrap"><table><thead><tr><th>Asset</th><th>Address</th><th>Kind</th><th class="n">Units</th><th class="n">Price</th><th class="n">Round</th><th class="n">Value</th><th class="n">Weight</th></tr></thead><tbody>${posRows || '<tr><td colspan="8" class="muted">No holdings.</td></tr>'}</tbody></table></div>
<h2>Guard denials</h2>
<div class="wrap"><table><thead><tr><th>When</th><th>Desk</th><th>Action</th><th>Status</th><th>Reason</th><th>Tx</th></tr></thead><tbody>${actRows(b.guardDenials)}</tbody></table></div>
<h2>Desk actions</h2>
<div class="wrap"><table><thead><tr><th>When</th><th>Desk</th><th>Action</th><th>Status</th><th>Reason</th><th>Tx</th></tr></thead><tbody>${actRows(b.deskActions)}</tbody></table></div>
<h2>Verification</h2>
<div class="grid">
${kv("PeriodClose", e.periodClose, true)}${kv("Account", b.account, true)}
${kv("Commit tx", e.txHash, true)}${kv("Block", e.blockNumber.toString())}
${kv("bundleHash", c.bundleHash, true)}${kv("positionsHash", c.positionsHash, true)}
${kv("policyHash", c.policyHash, true)}
</div>
<footer class="muted">Rendered only from the on-chain PeriodClosed event and the stored bundle whose keccak256 equals bundleHash.
Re-derive: keccak256 of the bundle JSON must equal bundleHash; keccak256(abi.encode(positions)) must equal positionsHash.</footer>
</main></body></html>
`;
}
