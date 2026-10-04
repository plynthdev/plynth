// Statement output: JSON (bigints as decimal strings), CSV (balances then movements), and one self-contained
// HTML page (inline CSS, no scripts, no external requests) a user can save or print.
import { formatUnits } from "viem";
import type { Statement } from "./statement";

const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}`;
const iso = (ts: bigint) => new Date(Number(ts) * 1000).toISOString();
const usd = (x: bigint | null) => (x === null ? "" : formatUnits(x, 18));

/** JSON-safe copy: bigints become strings, field elements become 0x-hex. Blindings are left out. */
export function statementToJson(s: Statement): Record<string, unknown> {
  return {
    version: s.version,
    kind: s.kind,
    chainId: s.chainId,
    pool: s.pool,
    ownerPk: hex32(s.ownerPk),
    period: { fromBlock: s.period.fromBlock.toString(), toBlock: s.period.toBlock.toString(), start: iso(s.period.start), end: iso(s.period.end) },
    spendsVisible: s.spendsVisible,
    totalUsd: usd(s.totalUsd18),
    balances: s.balances.map((b) => ({
      asset: b.asset,
      symbol: b.symbol,
      decimals: b.decimals,
      opening: b.opening.toString(),
      in: b.in.toString(),
      out: b.out.toString(),
      closing: b.closing.toString(),
      pending: b.pending.toString(),
      closingUnits: formatUnits(b.closing, b.decimals),
      usd: b.usd18 === null ? null : usd(b.usd18),
      priceUsd: b.priceUsd18 === null ? null : usd(b.priceUsd18),
      multiplier: b.multiplier18 === null ? null : usd(b.multiplier18),
      hold: b.hold,
    })),
    movements: s.movements.map((m) => ({
      time: iso(m.timestamp),
      block: m.block.toString(),
      txHash: m.txHash,
      type: m.type,
      kind: m.kind,
      asset: m.asset,
      symbol: m.symbol,
      raw: m.raw.toString(),
      commitment: hex32(m.commitment),
    })),
    notes: s.notes.map((n) => ({
      commitment: hex32(n.commitment),
      asset: n.asset,
      raw: n.raw.toString(),
      source: n.source,
      leafIndex: n.leafIndex,
      status: n.status,
      createdBlock: n.createdBlock.toString(),
      spentBlock: n.spentBlock?.toString() ?? null,
    })),
    generatedAt: s.generatedAt,
  };
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells: unknown[]) => cells.map(csvCell).join(",");

export function statementToCsv(s: Statement): string {
  const lines = [
    row(["section", "asset", "symbol", "opening", "in", "out", "closing", "pending", "usd", "price_usd", "multiplier", "hold"]),
    ...s.balances.map((b) =>
      row([
        "balance",
        b.asset,
        b.symbol,
        formatUnits(b.opening, b.decimals),
        formatUnits(b.in, b.decimals),
        formatUnits(b.out, b.decimals),
        formatUnits(b.closing, b.decimals),
        formatUnits(b.pending, b.decimals),
        usd(b.usd18),
        usd(b.priceUsd18),
        usd(b.multiplier18),
        b.hold,
      ]),
    ),
    "",
    row(["section", "time", "block", "type", "kind", "asset", "symbol", "amount", "raw", "tx"]),
    ...s.movements.map((m) => {
      const dec = s.balances.find((b) => b.asset === m.asset)?.decimals ?? 0;
      return row(["movement", iso(m.timestamp), m.block, m.type, m.kind, m.asset, m.symbol, formatUnits(m.raw, dec), m.raw, m.txHash]);
    }),
  ];
  return lines.join("\n") + "\n";
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function statementToHtml(s: Statement): string {
  const money = (x: bigint | null) => (x === null ? "n/a" : `$${Number(formatUnits(x, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const bal = s.balances
    .map(
      (b) =>
        `<tr><td>${esc(b.symbol)}</td><td class="n">${esc(formatUnits(b.opening, b.decimals))}</td><td class="n">${esc(formatUnits(b.in, b.decimals))}</td><td class="n">${esc(formatUnits(b.out, b.decimals))}</td><td class="n">${esc(formatUnits(b.closing, b.decimals))}</td><td class="n">${esc(formatUnits(b.pending, b.decimals))}</td><td class="n">${esc(money(b.usd18))}${b.hold ? ' <span class="hold">hold</span>' : ""}</td></tr>`,
    )
    .join("");
  const mov = s.movements
    .map((m) => {
      const dec = s.balances.find((b) => b.asset === m.asset)?.decimals ?? 0;
      return `<tr><td>${esc(iso(m.timestamp).replace("T", " ").slice(0, 19))}</td><td>${esc(m.type)}</td><td>${esc(m.kind)}</td><td>${esc(m.symbol)}</td><td class="n">${esc(formatUnits(m.raw, dec))}</td><td class="h">${esc(m.txHash)}</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viewing-key statement</title>
<style>
:root{--bg:#fff;--fg:#14161a;--mute:#5b6270;--line:#e3e6eb;--accent:#0b6e4f}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#e9ebee;--mute:#9aa1ad;--line:#2a2e35;--accent:#4cc79a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.meta{color:var(--mute);margin:0}.total{font-size:28px;font-weight:600;color:var(--accent);margin:16px 0 0}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--mute);font-weight:500}.n{text-align:right;font-variant-numeric:tabular-nums}.h{font-family:ui-monospace,monospace;font-size:12px}
.hold{font-size:11px;color:#b45309}.note{color:var(--mute);font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>Viewing-key statement</h1>
<p class="meta">Chain ${esc(s.chainId)} · pool ${esc(s.pool)}</p>
<p class="meta">${esc(iso(s.period.start))} to ${esc(iso(s.period.end))} (blocks ${esc(s.period.fromBlock)} to ${esc(s.period.toBlock)})</p>
<p class="total">${esc(money(s.totalUsd18))}</p>
<p class="meta">Value at period end${s.spendsVisible ? "" : " · spends not visible with a viewing key alone, balances count every received note"}</p>
<h2>Balances</h2>
<div class="wrap"><table><thead><tr><th>Asset</th><th class="n">Opening</th><th class="n">In</th><th class="n">Out</th><th class="n">Closing</th><th class="n">Pending</th><th class="n">Value</th></tr></thead><tbody>${bal || '<tr><td colspan="7">No notes</td></tr>'}</tbody></table></div>
<h2>Movements</h2>
<div class="wrap"><table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Kind</th><th>Asset</th><th class="n">Amount</th><th>Transaction</th></tr></thead><tbody>${mov || '<tr><td colspan="6">No movements in this period</td></tr>'}</tbody></table></div>
<p class="note">Generated ${esc(s.generatedAt)} from on-chain events. Stock Token values use the token multiplier and the price feed at the period's last block.</p>
</main></body></html>
`;
}
