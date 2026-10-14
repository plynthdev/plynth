// The live dashboard (local fork): same markup and classes as the preview in src/site/runtime.js, with the data
// from the API and every control wired to a real transaction. Rendered as an HTML string by the site runtime
// (mountSite({dashboard})), so the look stays exactly the Lovable one.
import type { Address, Hex } from "viem";
import type { DashboardKit, LiveDashboard } from "../site/runtime";
import * as A from "./actions";
import {
  api,
  type Activity,
  type CrowdBooks,
  type Habit,
  type Overview,
  type Settings,
  type Statements,
} from "./api";
import { forkConfig, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "./config";
import { deployment, deploymentMissing } from "./deployment";
import {
  allocationSegments,
  bookTimingText,
  chartPoints,
  esc,
  joinGate,
  mixGate,
  networkText,
  notDeployedText,
  recordProgress,
  renderTxLog,
  settingsMatch,
  type Gate,
  type LogEntry,
  trimDecimals,
  windowText,
  formatRaw,
  formatUsdg,
  MODE_NAMES,
  modeKey,
  money,
  shortHash,
  type ModeKey,
} from "./logic";
import {
  browserWallets,
  connectWallet,
  currentAccount,
  devWalletEnabled,
  disconnectWallet,
  onAccountChange,
  openWalletModal,
  restoreConnection,
  switchToProfileChain,
  walletModalEnabled,
} from "./wallet";

type Data = {
  overview?: Overview;
  habit?: Habit;
  activity?: Activity;
  settings?: Settings;
  statements?: Statements | null;
  books?: CrowdBooks;
  eligible?: boolean;
  balances?: { available: bigint; pending: bigint };
  walletUsdg?: bigint;
  metaAddress?: boolean;
  hiddenKeys?: boolean;
  claimables?: A.Claimable[];
  quietParts?: A.StealthPart[];
  notes?: A.HiddenNote[];
};

const S = {
  period: "1M" as "1W" | "1M" | "3M",
  data: {} as Data,
  loadedFor: "",
  loading: false,
  error: "" as string,
  busy: false,
  log: [] as LogEntry[],
  seq: 0,
  rerender: () => {},
  watching: false,
  /** The browser-wallet list is open (no WalletConnect project id, so no AppKit modal). */
  picker: false,
  /** CONNECT WALLET clicked, the modal is loading (first time: it is fetched on demand). */
  opening: false,
  /** Settings just confirmed on-chain: shown until the API reads them back (lagging public RPC node). */
  expect: undefined as { form: A.SettingsForm; until: number } | undefined,
};

const RANGE = { "1W": "1W", "1M": "1M", "3M": "3M" } as const;

// ---------------------------------------------------------------- data

async function load(force = false) {
  const acct = currentAccount();
  const key = acct ? `${acct.address}:${S.period}` : "none";
  if (!force && (S.loading || S.loadedFor === key)) return;
  S.loadedFor = key;
  if (!acct) {
    S.data = {};
    return;
  }
  S.loading = true;
  S.error = "";
  document.body.dataset.forkLoading = "1";
  S.rerender();
  const a = acct.address;
  try {
    const [
      overview,
      habit,
      activity,
      settings,
      books,
      eligible,
      balances,
      metaAddress,
      hiddenKeys,
      claimables,
      statements,
      walletUsdg,
    ] = await Promise.all([
      api.get<Overview>(`/v1/account/${a}/overview`),
      api.get<Habit>(`/v1/account/${a}/habit?range=${RANGE[S.period]}`),
      api.get<Activity>(`/v1/account/${a}/activity?limit=20`),
      api.get<Settings>(`/v1/account/${a}/settings`),
      api.get<CrowdBooks>(`/v1/crowd/books`),
      A.isEligible(a),
      A.vaultBalances(a),
      A.hasMetaAddress(a),
      A.hasHiddenKeys(a),
      A.claimables(a),
      A.statementsOf(a).catch(() => null),
      A.walletUsdg(a),
    ]);
    S.data = {
      ...S.data,
      overview,
      habit,
      activity,
      settings,
      books,
      eligible,
      balances,
      metaAddress,
      hiddenKeys,
      claimables,
      statements,
      walletUsdg,
    };
    applyExpectedSettings();
  } catch (e) {
    S.error = (e as Error).message;
  } finally {
    S.loading = false;
    delete document.body.dataset.forkLoading;
    S.rerender();
  }
}

/** Runs one action: busy flag on <body> (Playwright waits on it), a log entry with the tx hash, then a reload. */
async function run(label: string, f: (p: A.Progress) => Promise<unknown>) {
  if (S.busy) return;
  const entry: LogEntry = { id: ++S.seq, label, state: "running", msg: "starting…", txs: [] };
  S.log.unshift(entry);
  S.log = S.log.slice(0, 30);
  S.busy = true;
  document.body.dataset.forkBusy = "1";
  S.rerender();
  // Each confirmed transaction is listed once, nested under its action's line (it used to be listed twice).
  const progress: A.Progress = (msg, hash) => {
    recordProgress(entry, msg, hash);
    S.rerender();
  };
  try {
    await f(progress);
    entry.state = "ok";
    entry.pending = undefined;
    if (entry.msg === "starting…" || /waiting for the API/.test(entry.msg))
      entry.msg = entry.txs.length
        ? `${entry.txs.length} transaction${entry.txs.length === 1 ? "" : "s"} confirmed`
        : "done";
  } catch (e) {
    entry.state = "error";
    entry.msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
  } finally {
    S.busy = false;
    delete document.body.dataset.forkBusy;
    await load(true);
  }
}

// ---------------------------------------------------------------- markup helpers

const val = (id: string) =>
  (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)
    ?.value ?? "";
const n = (s: string | undefined) => Number(s ?? 0);
const disabled = () => (S.busy ? "disabled" : "");

const net = () => networkText(forkConfig().chainId);

function txLog(): string {
  return renderTxLog(S.log, `${net().short} · NO TRANSACTIONS YET`, forkConfig().explorerUrl);
}

/** Settings confirmed on-chain win over an API answer from a node that has not seen that block yet. */
function applyExpectedSettings() {
  const e = S.expect;
  if (!e) return;
  if (Date.now() > e.until || settingsMatch(e.form, S.data.settings)) {
    S.expect = undefined;
    return;
  }
  if (S.data.settings)
    S.data.settings = {
      ...S.data.settings,
      configured: true,
      roundTo: e.form.roundTo,
      multiplier: e.form.multiplier,
      weeklyCap: e.form.weeklyCap,
      fixedTopUp: e.form.fixedTopUp,
      mode: e.form.mode,
    };
  if (S.data.overview) S.data.overview = { ...S.data.overview, weeklyCap: e.form.weeklyCap, mode: e.form.mode };
}

/** A disabled button with its one-line reason and a link to where it gets fixed: [button, reason]. */
function gatedParts(action: string, label: string, gate: Gate, link?: { href: string; text: string; route?: boolean }): [string, string] {
  if (gate.ok) return [btn(action, label), ""];
  return [
    `<button class="solid-button" data-action="${action}" disabled aria-describedby="why-${action}">${label}</button>`,
    `<p class="fork-why" id="why-${action}" data-why="${action}">${esc(gate.reason)}${
      link ? ` <a class="text-link" href="${link.href}"${link.route ? " data-route" : ""}>${esc(link.text)}</a>` : ""
    }</p>`,
  ];
}
const gated = (...a: Parameters<typeof gatedParts>) => gatedParts(...a).join("");

function chart(): string {
  const pts = S.data.habit?.points ?? [];
  const line = chartPoints(pts.map((p) => n(p.savedUsdg)));
  return `<svg class="saving-chart" viewBox="0 0 600 220" role="img" aria-label="Saved USDG over the selected period"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#04c9ce" stop-opacity=".4"/><stop offset="1" stop-color="#04c9ce" stop-opacity="0"/></linearGradient></defs><g stroke="#11131416" stroke-width="1"><path d="M0 40H600M0 90H600M0 140H600M0 190H600"/></g><polygon points="0,220 ${line} 600,220" fill="url(#chart-fill)"/><polyline points="${line}" fill="none" stroke="#008d93" stroke-width="3" stroke-linejoin="round"/><g fill="#686b71" font-size="12" font-family="monospace"><text x="0" y="216">${esc(pts[0]?.date ?? "START")}</text><text x="520" y="216">TODAY</text></g></svg>`;
}

function activityTable(): string {
  const rows = S.data.activity?.rows ?? [];
  if (!rows.length)
    return `<p class="panel-intro">No activity yet. Deposit, set a mix and let round-ups accrue.</p>`;
  return `<div class="table-scroll"><table class="activity-table"><thead><tr><th>ACTIVITY</th><th>WHEN</th><th>AMOUNT</th><th>STATUS</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr data-kind="${esc(r.kind)}"><td>${esc(r.label)}${r.detail ? ` · ${esc(r.detail)}` : ""}</td><td>${esc(new Date(r.at).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</td><td>${esc(
          `${trimDecimals(r.amount)} ${r.unit}`,
        )}</td><td><span class="status-pill">${esc(r.status)}</span></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function modePicker(current: ModeKey): string {
  return `<div class="mode-picker" aria-label="Privacy mode">${(
    ["open", "quiet", "hidden"] as const
  )
    .map(
      (m, i) =>
        `<button class="mode-button ${current === m ? "chosen" : ""}" aria-pressed="${current === m}" data-live-mode="${m}" ${disabled()}><span class="mono">LEVEL ${i}</span><b>${MODE_NAMES[m]}</b><small>${["Public delivery", "Stealth addresses", "Shielded notes"][i]}</small></button>`,
    )
    .join("")}</div><p class="mode-description">${
    {
      open: "Public delivery. You claim your Crowd Buy allocation to your own address.",
      quiet:
        "Fresh stealth destinations for holdings, claimed through the relayer. Your funding transfers remain visible.",
      hidden:
        "Shielded notes in the Hidden Vault, with viewing-key statements. Share a view when you choose.",
    }[current]
  }</p>`;
}

function field(id: string, label: string, help: string, input: string): string {
  return `<div class="setting-row"><div><label for="${id}">${label}</label><p>${help}</p></div>${input}</div>`;
}
/** A text input; what the person already typed survives a re-render (a background reload used to wipe it). */
const input = (id: string, value = "", placeholder = "", type = "text") => {
  const typed = (document.getElementById(id) as HTMLInputElement | null)?.value;
  return `<input class="fork-input" id="${id}" type="${type}" value="${esc(typed ?? value)}" placeholder="${esc(placeholder)}" autocomplete="off">`;
};
const btn = (action: string, label: string, extra = "") =>
  `<button class="solid-button" data-action="${action}" ${disabled()} ${extra}>${label}</button>`;

// ---------------------------------------------------------------- tabs

function allocationPanel(o: Overview | undefined): string {
  const segs = allocationSegments(o?.allocation);
  const bar = segs.length
    ? `<div class="allocation-bar fork-allocation" data-field="allocation-bar">${segs
        .map(
          (x) =>
            `<i class="alloc-${x.key}" data-segment="${x.key}" style="width:${x.pct}%" title="${esc(x.label)} ${money(x.usd)}"></i>`,
        )
        .join("")}</div>`
    : `<div class="allocation-bar fork-allocation fork-allocation-empty" data-field="allocation-bar" data-empty="1"><span class="mono">NOTHING ALLOCATED YET · DEPOSIT USDG TO START</span></div>`;
  const row = (key: string, label: string, v: string | undefined, field?: string) =>
    `<p><span><i class="alloc-dot alloc-${key}" aria-hidden="true"></i>${label}</span><b${field ? ` data-field="${field}"` : ""}>${money(v ?? 0)}</b></p>`;
  return `<section class="dash-panel"><h2>Your allocation</h2>${bar}<div class="allocation-rows">${row("stocks", "Stock tokens", o?.allocation.stockTokensUsd, "stocks")}${row("park", "Private park", o?.allocation.parkUsd)}${row("usdg", "Available USDG", o?.allocation.availableUsdg, "available")}</div>${
    o?.holdings.length
      ? `<div class="allocation-rows">${o.holdings.map((h) => `<p><span>${esc(h.symbol)}${n(h.claimableRaw) > 0 ? " (claimable)" : ""}</span><b>${formatRaw(h.raw)} · ${money(h.usd)}</b></p>`).join("")}</div>`
      : ""
  }</section>`;
}

function crowdPanel(): string {
  const all = S.data.books?.books ?? [];
  const books = all.filter((x) => x.open.accounts > 0);
  const pending = S.data.balances?.pending;
  const w = S.data.books?.window;
  const gate = joinGate(S.data.eligible, pending);
  const link = !S.data.eligible
    ? { href: "/dashboard/settings/", text: "Go to eligibility", route: true }
    : { href: "/dashboard/settings/", text: "Import a statement", route: true };
  const join = gatedParts("join", "JOIN CROWD NOW", gate, link);
  return `<section class="dash-panel" data-field="crowd"><div class="panel-heading"><h2>Crowd Buy</h2><span class="mono">MIN CROWD ${esc(all[0]?.open.minCrowd ?? "")}</span></div>
<p class="panel-intro">Your round-ups buy Stock Tokens together with other savers. <b>Join only uses pending round-ups</b>: you have <b data-field="crowd-pending">${formatUsdg(pending ?? 0n)}</b> USDG pending. <b>The keeper joins you automatically</b> every few seconds, so you rarely need the button. A book executes once it has the minimum crowd, at a jittered time inside the window. <span class="mono" data-field="crowd-window">${esc(windowText(w))}</span></p>
<p class="panel-intro fork-howto">How to get round-ups: <a class="text-link" href="/dashboard/settings/" data-route>import a bank statement</a> (CSV) in Settings; each spend rounds up to your “round to” increment and the keeper accrues it as pending.</p>${
    books.length
      ? `<div class="allocation-rows" data-field="crowd-books">${books.map((x) => `<p><span>${esc(x.symbol)} · book ${esc(x.open.bookId)} · <small data-field="next-execution">${esc(bookTimingText({ symbol: x.symbol, accounts: x.open.accounts, minCrowd: x.open.minCrowd, executeAfter: x.open.executeAfter, executedThisWindow: x.open.executedThisWindow }, w))}</small></span><b>${x.open.accounts}/${x.open.minCrowd} accounts · ${esc(x.open.usdgTotal)} USDG</b></p>`).join("")}</div>`
      : `<p class="panel-intro">No open orders right now.</p>`
  }<div class="fork-actions">${join[0]}${btn("claim-open", `CLAIM ${S.data.claimables?.length ?? 0} ALLOCATION(S)`)}</div>${join[1]}</section>`;
}

function overviewTab(): string {
  const o = S.data.overview;
  const b = S.data.balances;
  const wal = S.data.walletUsdg;
  return `<div class="dashboard-stats"><article class="stat-folder"><span class="mono">TOTAL HOLDINGS</span><strong data-field="total">${money(o?.totalHoldingsUsd ?? 0)}</strong><p>Stock Tokens, parked shares and USDG</p></article><article class="stat-folder pink"><span class="mono">THIS WEEK’S ROUND-UPS</span><strong data-field="week">${money(o?.weekRoundups ?? 0)}</strong><p>Weekly cap · <span data-field="weekly-cap">${money(o?.weeklyCap ?? 0)}</span></p></article><article class="stat-folder cyan"><span class="mono">PRIVACY MODE</span><strong data-field="mode">${MODE_NAMES[o?.mode ?? "open"]}</strong><p>Set on-chain in your vault settings</p></article></div>
<div class="dashboard-middle"><section class="dash-panel savings-panel"><div class="panel-heading"><h2>Your saving habit</h2><div class="periods">${(
    ["1W", "1M", "3M"] as const
  )
    .map(
      (p) =>
        `<button data-live-period="${p}" class="${p === S.period ? "active" : ""}" aria-pressed="${p === S.period}">${p}</button>`,
    )
    .join(
      "",
    )}</div></div><div class="chart-wrap">${chart()}</div><p class="mono chart-note">SAVED USDG · ${esc(net().short)} DATA</p></section>${allocationPanel(o)}</div>
<section class="dash-panel settings-panel"><p class="mono">SAVINGS VAULT · USDG</p><h2>Deposit and withdraw</h2><p class="panel-intro">In the vault: <b data-field="vault-available">${formatUsdg(b?.available ?? 0n)}</b> USDG available, <b data-field="vault-pending">${formatUsdg(b?.pending ?? 0n)}</b> USDG pending round-ups. Withdrawals are never gated.</p>
${field("deposit-amount", "Deposit", `USDG from your wallet into the savings vault (approves first if needed). In your wallet: <b data-field="wallet-usdg">${formatUsdg(wal ?? 0n)}</b> USDG.`, `<div class="cap-control">${input("deposit-amount", "", "100")}<button class="solid-button fork-max" data-action="deposit-max" ${S.busy || !wal ? "disabled" : ""}>MAX</button>${btn("deposit", "DEPOSIT")}</div>`)}
${field("withdraw-amount", "Withdraw", "From available first, then pending. Leave the address empty to withdraw to yourself.", `<div class="cap-control">${input("withdraw-amount", "", "25")}${input("withdraw-to", "", "0x… (optional)")}${btn("withdraw", "WITHDRAW")}${btn("withdraw-all", "WITHDRAW ALL")}</div>`)}
</section>
${crowdPanel()}
<section class="dash-panel"><div class="panel-heading"><h2>Privacy, by choice</h2><a href="/dashboard/privacy/" data-route class="text-link mono">EXPLORE MODES</a></div>${modePicker(o?.mode ?? "open")}</section>
<section class="dash-panel"><div class="panel-heading"><h2>Recent activity</h2><a href="/dashboard/activity/" data-route class="text-link mono">VIEW ALL</a></div>${activityTable()}</section>`;
}

function privacyTab(): string {
  const mode = S.data.overview?.mode ?? S.data.settings?.mode ?? "open";
  const st = S.data.statements;
  const parts = S.data.quietParts;
  const notes = S.data.notes;
  return `<section class="dash-panel"><p class="mono">OPEN · QUIET · HIDDEN</p><h2>Choose a privacy boundary</h2><p class="panel-intro">Switching sends a settings transaction. Quiet first registers your stealth meta-address (ERC-6538); Hidden first registers your vault keys. Meta-address: <b data-field="meta">${S.data.metaAddress ? "registered" : "not registered"}</b> · Hidden keys: <b data-field="hidden-keys">${S.data.hiddenKeys ? "registered" : "not registered"}</b>.</p>${modePicker(mode)}</section>
<section class="dash-panel settings-panel"><p class="mono">QUIET · STEALTH DELIVERY</p><h2>Claim through the relayer</h2><p class="panel-intro">Your viewing key finds the stealth parts the keeper delivered for you; the relayer pays the gas, so no wallet is linked to them.${
    parts
      ? ` Waiting parts: <b data-field="quiet-parts">${parts.length}</b>${parts.length ? ` (${parts.map((p) => `${formatRaw(p.raw)} of ${shortHash(p.token)}`).join(", ")})` : ""}.`
      : ""
  }</p>${field("quiet-to", "Claim to", "A fresh address you control (empty = this wallet).", `<div class="cap-control">${input("quiet-to", "", "0x…")}${btn("quiet-scan", "SCAN")}${btn("quiet-claim", "CLAIM VIA RELAYER")}</div>`)}</section>
<section class="dash-panel settings-panel"><p class="mono">HIDDEN · SHIELDED NOTES</p><h2>Hidden Vault</h2><p class="panel-intro">Deposits wait about an hour in the pending queue, then the keeper inserts them into the note tree. Withdrawals are proven in your browser.${
    notes
      ? ` Notes: <b data-field="notes">${notes.filter((x) => !x.spent).length}</b> unspent${notes.length ? ` (<span data-field="notes-detail">${notes.map((x) => `${x.leafIndex === null ? "pending " : ""}${formatRaw(x.raw, 6)}${x.spent ? " spent" : ""}`).join(", ")}</span>)` : ""}.`
      : ""
  }</p>${field("hidden-amount", "Hidden deposit", "USDG into a shielded note owned by your vault key.", `<div class="cap-control">${input("hidden-amount", "", "50")}${btn("hidden-deposit", "DEPOSIT")}</div>`)}${field("hidden-to", "Hidden withdraw", "Your largest USDG note to an address (empty = this wallet).", `<div class="cap-control">${input("hidden-to", "", "0x…")}${btn("hidden-notes", "REFRESH NOTES")}${btn("hidden-withdraw", "WITHDRAW NOTE")}</div>`)}</section>
<section class="dash-panel exposure-panel"><h2>What each mode reveals</h2><div class="privacy-comparison"><div><b>Open</b><p>The delivery address and its holdings remain public.</p></div><div><b>Quiet</b><p>Funding remains visible; holdings arrive at fresh stealth addresses.</p></div><div><b>Hidden</b><p>Holdings live as notes. A viewing key enables statements.</p></div></div></section>
<section class="dash-panel"><h2>Your view, when you choose</h2><p class="panel-intro">Monthly viewing-key statements exist once Hidden keys are registered; the server never sees your keys.</p>${
    st && st.statements.length
      ? `<div class="table-scroll"><table class="activity-table" data-field="statements"><thead><tr><th>STATEMENT</th><th>PERIOD</th><th>BLOCKS</th><th>STATUS</th></tr></thead><tbody>${st.statements
          .map(
            (s) =>
              `<tr><td>${esc(s.title)}</td><td>${esc(s.period.start.slice(0, 10))} → ${esc(s.period.end.slice(0, 10))}</td><td>${esc(s.period.fromBlock)}–${esc(s.period.toBlock)}</td><td><span class="status-pill">${esc(s.status)}</span></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<p class="panel-intro" data-field="statements">${st?.hidden ? "No statement periods yet." : "Register Hidden keys (choose Hidden) to get statements."}</p>`
  }${btn("statements", "VIEW STATEMENT")}</section>`;
}

function settingsTab(): string {
  const s = S.data.settings;
  const sel = (id: string, opts: [string, string][], cur: string) =>
    `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const cap = s ? Math.round(n(s.weeklyCap)) : 50;
  const stocks = Object.entries(
    (S.data.books?.books ?? []).reduce<Record<string, Address>>(
      (m, b) => ((m[b.symbol] = b.asset), m),
      {},
    ),
  );
  const mixPct = new Map((s?.mix ?? []).map((m) => [m.token.toLowerCase(), m.weightBps / 100]));
  const today = new Date().toISOString().slice(0, 10);
  return `<section class="dash-panel settings-panel" id="eligibility"><p class="mono">ELIGIBILITY</p><h2>Self-attestation</h2><p class="panel-intro">Buying Stock Tokens needs an on-chain attestation: sign the statement, the screening service checks it (sanctions list, IP country) and you submit its attestation. Status: <b data-field="eligible">${S.data.eligible ? "eligible" : "not attested"}</b>.</p>${btn("attest", "SIGN AND ATTEST")}</section>
<section class="dash-panel settings-panel"><p class="mono">SAVING PREFERENCES</p><h2>Set your own limits</h2><p class="panel-intro">Saved on-chain in the savings vault (one transaction).</p>
${field(
  "round-to",
  "Round to",
  "The purchase amount rounds up to this increment.",
  sel(
    "round-to",
    [
      ["1", "1 USDG"],
      ["5", "5 USDG"],
      ["10", "10 USDG"],
    ],
    String(s?.roundTo || 1),
  ),
)}
${field(
  "multiplier",
  "Multiplier",
  "Scale the spare change set aside.",
  sel(
    "multiplier",
    [
      ["1", "1×"],
      ["2", "2×"],
      ["3", "3×"],
    ],
    String(s?.multiplier || 1),
  ),
)}
${field(
  "topup",
  "Fixed top-up",
  "Weekly fixed amount pulled through a Permit2 allowance (0 = off).",
  sel(
    "topup",
    [
      ["0", "Off"],
      ["25", "25 USDG"],
      ["50", "50 USDG"],
      ["100", "100 USDG"],
    ],
    String(Math.round(n(s?.fixedTopUp))),
  ),
)}
<div class="setting-row"><div><label for="weekly-cap">Weekly cap</label><p>Maximum spare change to accrue each week.</p></div><div class="cap-control"><output id="cap-value">${cap} USDG</output><input id="weekly-cap" type="range" min="10" max="500" step="5" value="${cap}"></div></div>
${btn("save-settings", "SAVE SETTINGS")}</section>
<section class="dash-panel settings-panel"><p class="mono">BUY MIX</p><h2>What your round-ups buy</h2><p class="panel-intro">Up to 5 Stock Tokens; percentages add up to 100.</p>${stocks
    .map(([sym, token]) =>
      field(
        `mix-${sym}`,
        esc(sym),
        esc(token),
        `<div class="cap-control"><input class="fork-input" id="mix-${esc(sym)}" data-mix-token="${token}" type="number" min="0" max="100" step="1" value="${mixPct.get(token.toLowerCase()) ?? ""}" placeholder="0"></div>`,
      ),
    )
    .join("")}${gated("save-mix", "SAVE MIX", mixGate(S.data.eligible), { href: "#eligibility", text: "Go to eligibility" })}</section>
<section class="dash-panel settings-panel" id="round-ups"><p class="mono">ROUND-UP SOURCES</p><h2>Import a bank statement</h2><p class="panel-intro">CSV with Date, Description, Amount (spends negative). Signed by your wallet; the keeper accrues each spend’s round-up.</p><textarea class="fork-input fork-textarea" id="statement-csv" rows="4">Date,Description,Amount
${today},Coffee roasters,-12.30</textarea>${btn("import-statement", "IMPORT STATEMENT")}</section>`;
}

function tabHtml(tab: string): string {
  if (tab === "overview") return overviewTab();
  if (tab === "activity")
    return `<section class="dash-panel"><p class="mono">${esc(net().short)} ACCOUNT</p><h2>Activity</h2><p class="panel-intro">Round-ups, top-ups, Crowd Buy orders and deliveries, from the indexer.</p>${activityTable()}</section>`;
  if (tab === "privacy") return privacyTab();
  if (tab === "settings") return settingsTab();
  return `<section class="dash-panel"><h2>Page not found</h2><a href="/dashboard/" data-route>Return to overview</a></section>`;
}

function html(path: string, kit: DashboardKit): string {
  const tab = path.split("/")[2] || "overview";
  const tabs = [
    ["overview", "OVERVIEW", "dashboard"],
    ["activity", "ACTIVITY", "journal"],
    ["privacy", "PRIVACY", "about"],
    ["settings", "SETTINGS", "services"],
  ];
  const acct = currentAccount();
  const dev = devWalletEnabled();
  const cfg = forkConfig();
  const nt = networkText(cfg.chainId);
  // No contracts on this chain yet (mainnet before the beta deploy): say so instead of offering to connect.
  const notDeployed = deploymentMissing();
  const nd = notDeployedText(cfg.chainId);
  const wallet = notDeployed
    ? ""
    : acct
    ? `<div class="fork-wallet-bar"><span class="preview-badge mono fork-wallet-chip" data-connected-wallet="${esc(acct.wallet)}" title="${acct.address}">${acct.icon ? `<img src="${esc(acct.icon)}" alt="" width="16" height="16">` : ""}${esc(acct.wallet)} · ${shortHash(acct.address)}</span>${acct.chainOk ? "" : `<button class="solid-button fork-wrong-chain" data-action="switch-network">SWITCH TO ${esc(cfg.chainName)}</button>`}<button class="solid-button" data-action="disconnect" title="${acct.address}">DISCONNECT</button></div>`
    : `<div class="fork-wallet-bar"><button class="solid-button" data-action="connect" aria-haspopup="dialog" ${S.opening ? "disabled" : ""}>${S.opening ? "OPENING…" : "CONNECT WALLET"}</button>${dev ? `<button class="solid-button" data-action="connect-dev">DEV WALLET</button>` : ""}</div>`;
  const body = notDeployed
    ? `<section class="dash-panel" data-not-deployed><p class="mono">${esc(nt.short)} · CHAIN ${cfg.chainId} · NOT DEPLOYED YET</p><h2>${esc(nd.title)}</h2><p class="panel-intro">${esc(nd.body)}</p></section>`
    : !acct
    ? `${S.picker ? walletPicker(dev) : ""}<section class="dash-panel"><p class="mono">${esc(nt.short)} · CHAIN ${cfg.chainId}</p><h2>Connect a wallet</h2><p class="panel-intro">Use a browser wallet (MetaMask, Rabby, Coinbase Wallet…)${walletModalEnabled() ? " or a phone wallet through WalletConnect" : ""} on the “${esc(cfg.chainName)}” network (RPC ${esc(cfg.rpcUrl)}, chain id ${cfg.chainId}) with ${connectWho(cfg.chainId, dev)}</p></section>`
    : `${S.error ? `<p class="settings-status mono fork-error" role="alert">COULD NOT LOAD: ${esc(S.error)}</p>` : ""}${S.loading && !S.data.overview ? `<p class="settings-status mono" data-field="loading">LOADING FROM THE ${esc(nt.short)}…</p>` : ""}${tabHtml(tab)}`;
  return `<section class="dashboard-shell wrap" data-fork-dashboard data-account="${acct?.address ?? ""}"><div class="dashboard-heading"><div><p class="hand">your private foundation</p><h1 class="pixel">DASHBOARD</h1></div><span class="preview-badge mono" data-network-badge="${nt.kind}">${esc(nt.badge)}</span>${
    // Only when the dev wallet is the connected connector, never just because it could be offered.
    acct?.kind === "dev"
      ? `<span class="preview-badge mono fork-dev-badge" data-dev-wallet-badge>DEV WALLET — LOCAL FORK</span>`
      : ""
  }${wallet}</div><div class="dashboard-layout"><aside class="dashboard-nav" aria-label="Dashboard sections">${tabs
    .map(
      ([id, t, s]) =>
        `<a data-route href="/dashboard/${id === "overview" ? "" : id + "/"}" class="${tab === id ? "active" : ""}">${kit.icon(s!)}<span class="mono">${t}</span></a>`,
    )
    .join(
      "",
    )}<div class="account-note">${kit.logo()}<b>plynth</b><span class="mono">${acct ? esc(shortHash(acct.address)) : "NOT CONNECTED"}</span></div></aside><div class="dashboard-content">${body}<section class="dash-panel"><h2>Transactions</h2>${txLog()}</section><p class="dashboard-footnote" data-field="footnote">${esc(nt.footnote)}</p></div></div></section>${kit.footer(false)}`;
}

// ---------------------------------------------------------------- events

const handlers: Record<string, (el: HTMLElement) => void> = {
  // The AppKit modal when a WalletConnect project id is set, the browser-wallet list otherwise (or if it fails).
  connect: () => {
    S.opening = true;
    S.rerender();
    void openWalletModal().then(
      (opened) => {
        S.opening = false;
        if (!opened) S.picker = !S.picker;
        S.rerender();
      },
      () => {
        S.opening = false;
        S.picker = true;
        S.rerender();
      },
    );
  },
  "connect-wallet": (el) => {
    const uid = el.dataset["wallet"] ?? "";
    void run(`Connect ${el.dataset["walletName"] ?? "wallet"}`, async () => {
      await connectWallet(uid);
      S.picker = false;
    });
  },
  "close-picker": () => ((S.picker = false), S.rerender()),
  "connect-dev": () =>
    void run("Connect dev wallet", async () => void (await connectWallet("dev"))),
  "switch-network": () =>
    void run(`Switch to ${forkConfig().chainName}`, () => switchToProfileChain()),
  disconnect: () =>
    void disconnectWallet().then(() => ((S.data = {}), (S.loadedFor = ""), S.rerender())),
  attest: () => void run("Eligibility", (p) => A.attestEligibility(p)),
  "deposit-max": () => {
    const el = document.getElementById("deposit-amount") as HTMLInputElement | null;
    if (el && S.data.walletUsdg) el.value = formatUsdg(S.data.walletUsdg);
  },
  deposit: () => {
    const amt = val("deposit-amount");
    void run("Deposit", (p) => A.deposit(amt, p));
  },
  withdraw: () => {
    const amt = val("withdraw-amount");
    const to = val("withdraw-to");
    void run("Withdraw", (p) => A.withdraw(amt, to || undefined, p));
  },
  "withdraw-all": () =>
    void run("Withdraw all", async (p) => {
      if (!(await A.withdrawAll(p))) throw new Error("Nothing in the vault to withdraw.");
    }),
  "save-settings": () => {
    const s = {
      roundTo: Number(val("round-to")),
      multiplier: Number(val("multiplier")),
      weeklyCap: val("weekly-cap"),
      fixedTopUp: val("topup"),
      mode: (S.data.settings?.mode ?? "open") as A.SettingsForm["mode"],
    };
    void run("Save settings", async (p) => {
      await A.saveSettings(s, p);
      S.expect = { form: s, until: Date.now() + 60_000 };
    });
  },
  "save-mix": () => {
    const rows = [...document.querySelectorAll<HTMLInputElement>("[data-mix-token]")].map((i) => ({
      token: i.dataset.mixToken as Address,
      percent: i.value,
    }));
    void run("Save mix", (p) => A.saveMix(rows, p));
  },
  "import-statement": () => {
    const csv = val("statement-csv");
    void run("Import statement", (p) => A.importStatement(csv, p));
  },
  join: () => void run("Join crowd", (p) => A.joinCrowd(p)),
  "claim-open": () => void run("Claim (Open)", (p) => A.claimOpenAll(p)),
  "quiet-scan": () =>
    void run("Scan stealth parts", async (p) => {
      S.data.quietParts = await A.quietParts(p);
      p(`found ${S.data.quietParts.length} waiting part(s)`);
    }),
  "quiet-claim": () => {
    const to = val("quiet-to") || currentAccount()?.address || "";
    void run("Quiet claim", async (p) => {
      await A.quietClaim(to, p);
      S.data.quietParts = await A.quietParts();
    });
  },
  "hidden-deposit": () => {
    const amt = val("hidden-amount");
    void run("Hidden deposit", async (p) => {
      await A.hiddenDeposit(amt, p);
      S.data.notes = await A.hiddenNotes(p);
    });
  },
  "hidden-notes": () =>
    void run("Hidden notes", async (p) => {
      S.data.notes = await A.hiddenNotes(p);
      p(`${S.data.notes.filter((x) => !x.spent).length} unspent note(s)`);
    }),
  "hidden-withdraw": () => {
    const to = val("hidden-to") || currentAccount()?.address || "";
    void run("Hidden withdraw", async (p) => {
      await A.hiddenWithdraw(to, p);
      S.data.notes = await A.hiddenNotes(p);
    });
  },
  statements: () =>
    void run("Statements", async (p) => {
      const a = currentAccount();
      if (!a) throw new Error("Connect a wallet first.");
      S.data.statements = await A.statementsOf(a.address);
      p(`${S.data.statements.statements.length} statement period(s)`);
    }),
};

function setup(ctx: { rerender(): void; signal: AbortSignal }) {
  S.rerender = ctx.rerender;
  if (!S.watching) {
    S.watching = true;
    onAccountChange(() => {
      if (currentAccount()) S.picker = false;
      S.loadedFor = "";
      S.data = {};
      S.rerender();
    });
    document.body.dataset.forkLoading = "1";
    // Learn early whether this chain has a deployment at all, so the page can say "not deployed yet" up front.
    void deployment().catch(() => {
      if (deploymentMissing()) S.rerender();
    });
    void restoreConnection().then(() => {
      delete document.body.dataset.forkLoading;
      S.loadedFor = "";
      S.rerender();
    });
    return;
  }
  const root = document.querySelector("[data-fork-dashboard]");
  root?.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      const a = t.closest<HTMLElement>("[data-action]");
      if (a && !a.hasAttribute("disabled")) return handlers[a.dataset.action!]?.(a);
      const m = t.closest<HTMLElement>("[data-live-mode]");
      if (m && !m.hasAttribute("disabled")) {
        const mode = modeKey(m.dataset.liveMode!);
        if (mode !== (S.data.overview?.mode ?? S.data.settings?.mode))
          void run(`Switch to ${MODE_NAMES[mode]}`, (p) => A.switchMode(mode, p));
        return;
      }
      const per = t.closest<HTMLElement>("[data-live-period]");
      if (per) {
        S.period = per.dataset.livePeriod as typeof S.period;
        void load();
      }
    },
    { signal: ctx.signal },
  );
  document.getElementById("weekly-cap")?.addEventListener(
    "input",
    (e) => {
      const out = document.getElementById("cap-value");
      if (out) out.textContent = `${(e.target as HTMLInputElement).value} USDG`;
    },
    { signal: ctx.signal },
  );
  void load();
}

export const liveDashboard: LiveDashboard = { html, setup };

/** Test hook: reset the module state. */

/**
 * The browser-wallet list shown when there is no WalletConnect project id: one button per EIP-6963 wallet (its own
 * name and icon), or the plain injected wallet, or how to get one.
 */
export function walletPicker(dev: boolean): string {
  const list = browserWallets();
  const items = list
    .map(
      (w) =>
        `<li><button class="fork-wallet-option" data-action="connect-wallet" data-wallet="${esc(w.uid)}" data-wallet-name="${esc(w.name)}">${w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28">` : `<span class="fork-wallet-blank" aria-hidden="true"></span>`}<span>${esc(w.name)}</span></button></li>`,
    )
    .join("");
  const none = `<p class="panel-intro" data-no-wallets>No browser wallet found on this device. Install a wallet extension (MetaMask, Rabby, Coinbase Wallet), or on a phone open this page in your wallet app’s own browser.${dev ? " Or use the DEV WALLET button." : ""}</p>`;
  return `<section class="dash-panel fork-wallet-picker" role="dialog" aria-label="Choose a wallet" data-wallet-picker><div class="fork-picker-head"><p class="mono">CHOOSE A WALLET</p><button class="fork-picker-close mono" data-action="close-picker" aria-label="Close">CLOSE</button></div>${list.length ? `<ul class="fork-wallet-list">${items}</ul>` : none}</section>`;
}

/** Who connects on each network: the beta's real wallet on mainnet, a testnet-only account, or an anvil dev account. */
export function connectWho(chainId: number, dev: boolean): string {
  if (chainId === MAINNET_CHAIN_ID)
    return "the wallet you were invited to the closed beta with (real USDG and ETH: this is mainnet).";
  if (chainId === TESTNET_CHAIN_ID)
    return "a testnet-only account (mock USDG, testnet ETH). Never import a real wallet.";
  return `an imported anvil dev account${dev ? ", or the dev wallet" : ""}. Never import a real wallet.`;
}

export function _resetForTests() {
  Object.assign(S, {
    period: "1M",
    data: {},
    loadedFor: "",
    loading: false,
    error: "",
    busy: false,
    log: [],
    seq: 0,
    watching: false,
    picker: false,
    opening: false,
    expect: undefined,
  });
}
