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
import { forkConfig, TESTNET_CHAIN_ID } from "./config";
import {
  chartPoints,
  esc,
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
  connectWallet,
  currentAccount,
  devWalletEnabled,
  disconnectWallet,
  onAccountChange,
  restoreConnection,
} from "./wallet";

type LogEntry = {
  id: number;
  label: string;
  state: "running" | "ok" | "error";
  msg: string;
  hash?: Hex;
  pending?: Hex | undefined;
};
type Data = {
  overview?: Overview;
  habit?: Habit;
  activity?: Activity;
  settings?: Settings;
  statements?: Statements | null;
  books?: CrowdBooks;
  eligible?: boolean;
  balances?: { available: bigint; pending: bigint };
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
    };
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
  const entry: LogEntry = { id: ++S.seq, label, state: "running", msg: "starting…" };
  S.log.unshift(entry);
  S.log = S.log.slice(0, 30);
  S.busy = true;
  document.body.dataset.forkBusy = "1";
  S.rerender();
  const progress: A.Progress = (msg, hash) => {
    entry.msg = msg;
    entry.pending = hash;
    // Every confirmed transaction gets its own line carrying its hash (newest first, under the action's line).
    if (hash && /confirmed/.test(msg)) {
      entry.pending = undefined;
      S.log.splice(S.log.indexOf(entry) + 1, 0, { id: ++S.seq, label, state: "ok", msg, hash });
    }
    S.rerender();
  };
  try {
    await f(progress);
    entry.state = "ok";
    entry.pending = undefined;
    if (entry.msg === "starting…") entry.msg = "done";
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

function txLog(): string {
  if (!S.log.length)
    return `<p class="settings-status mono" id="fork-status" aria-live="polite">LOCAL FORK · NO TRANSACTIONS YET</p>`;
  return `<ol class="fork-log" id="fork-log" aria-live="polite">${S.log
    .map(
      (l) =>
        `<li data-state="${l.state}" data-label="${esc(l.label)}"${l.hash ? ` data-tx-hash="${l.hash}"` : ""}><span class="mono">${l.state === "running" ? "…" : l.state === "ok" ? "OK" : "ERROR"}</span> <b>${esc(l.label)}</b> ${esc(l.msg)}${
          (l.hash ?? l.pending)
            ? ` <code title="${l.hash ?? l.pending}">${shortHash((l.hash ?? l.pending)!)}</code>`
            : ""
        }</li>`,
    )
    .join("")}</ol>`;
}

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
const input = (id: string, value = "", placeholder = "", type = "text") =>
  `<input class="fork-input" id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`;
const btn = (action: string, label: string, extra = "") =>
  `<button class="solid-button" data-action="${action}" ${disabled()} ${extra}>${label}</button>`;

// ---------------------------------------------------------------- tabs

function overviewTab(): string {
  const o = S.data.overview;
  const total =
    n(o?.allocation.stockTokensUsd) + n(o?.allocation.parkUsd) + n(o?.allocation.availableUsdg);
  const pct = (x: string | undefined) =>
    total > 0 ? Math.max(0, Math.round((n(x) / total) * 1000) / 10) : 0;
  const b = S.data.balances;
  const books = (S.data.books?.books ?? []).filter((x) => x.open.accounts > 0);
  return `<div class="dashboard-stats"><article class="stat-folder"><span class="mono">TOTAL HOLDINGS</span><strong data-field="total">${money(o?.totalHoldingsUsd ?? 0)}</strong><p>Stock Tokens, parked shares and USDG</p></article><article class="stat-folder pink"><span class="mono">THIS WEEK’S ROUND-UPS</span><strong data-field="week">${money(o?.weekRoundups ?? 0)}</strong><p>Weekly cap · ${money(o?.weeklyCap ?? 0)}</p></article><article class="stat-folder cyan"><span class="mono">PRIVACY MODE</span><strong data-field="mode">${MODE_NAMES[o?.mode ?? "open"]}</strong><p>Set on-chain in your vault settings</p></article></div>
<div class="dashboard-middle"><section class="dash-panel savings-panel"><div class="panel-heading"><h2>Your saving habit</h2><div class="periods">${(
    ["1W", "1M", "3M"] as const
  )
    .map(
      (p) =>
        `<button data-live-period="${p}" class="${p === S.period ? "active" : ""}" aria-pressed="${p === S.period}">${p}</button>`,
    )
    .join(
      "",
    )}</div></div><div class="chart-wrap">${chart()}</div><p class="mono chart-note">SAVED USDG · LOCAL FORK DATA</p></section><section class="dash-panel"><h2>Your allocation</h2><div class="allocation-bar"><i style="width:${pct(o?.allocation.stockTokensUsd)}%"></i><i style="width:${pct(o?.allocation.parkUsd)}%"></i><i style="width:${pct(o?.allocation.availableUsdg)}%"></i></div><div class="allocation-rows"><p><span>Stock tokens</span><b data-field="stocks">${money(o?.allocation.stockTokensUsd ?? 0)}</b></p><p><span>Private park</span><b>${money(o?.allocation.parkUsd ?? 0)}</b></p><p><span>Available USDG</span><b data-field="available">${money(o?.allocation.availableUsdg ?? 0)}</b></p></div>${
    o?.holdings.length
      ? `<div class="allocation-rows">${o.holdings.map((h) => `<p><span>${esc(h.symbol)}${n(h.claimableRaw) > 0 ? " (claimable)" : ""}</span><b>${formatRaw(h.raw)} · ${money(h.usd)}</b></p>`).join("")}</div>`
      : ""
  }</section></div>
<section class="dash-panel settings-panel"><p class="mono">SAVINGS VAULT · USDG</p><h2>Deposit and withdraw</h2><p class="panel-intro">In the vault: <b data-field="vault-available">${formatUsdg(b?.available ?? 0n)}</b> USDG available, <b data-field="vault-pending">${formatUsdg(b?.pending ?? 0n)}</b> USDG pending round-ups. Withdrawals are never gated.</p>
${field("deposit-amount", "Deposit", "USDG from your wallet into the savings vault (approves first if needed).", `<div class="cap-control">${input("deposit-amount", "", "100")}${btn("deposit", "DEPOSIT")}</div>`)}
${field("withdraw-amount", "Withdraw", "From available first, then pending. Leave the address empty to withdraw to yourself.", `<div class="cap-control">${input("withdraw-amount", "", "25")}${input("withdraw-to", "", "0x… (optional)")}${btn("withdraw", "WITHDRAW")}${btn("withdraw-all", "WITHDRAW ALL")}</div>`)}
</section>
<section class="dash-panel"><div class="panel-heading"><h2>Crowd Buy</h2><span class="mono">MIN CROWD ${esc(S.data.books?.books[0]?.open.minCrowd ?? "")}</span></div><p class="panel-intro">Pending round-ups join the open books (the keeper joins them too). A book executes once its crowd is big enough and the window’s jittered time has passed. <span class="mono">${esc(windowText(S.data.books?.window))}</span></p>${
    books.length
      ? `<div class="allocation-rows">${books.map((x) => `<p><span>${esc(x.symbol)} · book ${esc(x.open.bookId)}</span><b>${x.open.accounts}/${x.open.minCrowd} accounts · ${esc(x.open.usdgTotal)} USDG</b></p>`).join("")}</div>`
      : `<p class="panel-intro">No open orders right now.</p>`
  }<div class="fork-actions">${btn("join", "JOIN CROWD NOW")}${btn("claim-open", `CLAIM ${S.data.claimables?.length ?? 0} ALLOCATION(S)`)}</div></section>
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
  return `<section class="dash-panel settings-panel"><p class="mono">ELIGIBILITY</p><h2>Self-attestation</h2><p class="panel-intro">Buying Stock Tokens needs an on-chain attestation: sign the statement, the screening service checks it (sanctions list, IP country) and you submit its attestation. Status: <b data-field="eligible">${S.data.eligible ? "eligible" : "not attested"}</b>.</p>${btn("attest", "SIGN AND ATTEST")}</section>
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
    .join("")}${btn("save-mix", "SAVE MIX")}</section>
<section class="dash-panel settings-panel"><p class="mono">ROUND-UP SOURCES</p><h2>Import a bank statement</h2><p class="panel-intro">CSV with Date, Description, Amount (spends negative). Signed by your wallet; the keeper accrues each spend’s round-up.</p><textarea class="fork-input fork-textarea" id="statement-csv" rows="4">Date,Description,Amount
${today},Coffee roasters,-12.30</textarea>${btn("import-statement", "IMPORT STATEMENT")}</section>`;
}

function tabHtml(tab: string): string {
  if (tab === "overview") return overviewTab();
  if (tab === "activity")
    return `<section class="dash-panel"><p class="mono">LOCAL FORK ACCOUNT</p><h2>Activity</h2><p class="panel-intro">Round-ups, top-ups, Crowd Buy orders and deliveries, from the indexer.</p>${activityTable()}</section>`;
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
  const wallet = acct
    ? `<button class="solid-button" data-action="disconnect" title="${acct.address}">${shortHash(acct.address)} · DISCONNECT</button>`
    : `<button class="solid-button" data-action="connect">CONNECT WALLET</button>${dev ? `<button class="solid-button" data-action="connect-dev">DEV WALLET</button>` : ""}`;
  const body = !acct
    ? `<section class="dash-panel"><p class="mono">${cfg.chainId === TESTNET_CHAIN_ID ? "TESTNET" : "LOCAL FORK"} · CHAIN ${cfg.chainId}</p><h2>Connect a wallet</h2><p class="panel-intro">Use MetaMask on the “${esc(cfg.chainName)}” network (RPC ${esc(cfg.rpcUrl)}, chain id ${cfg.chainId}) with ${cfg.chainId === TESTNET_CHAIN_ID ? "a testnet-only account (mock USDG, testnet ETH)" : `an imported anvil dev account${dev ? ", or the dev wallet" : ""}`}. Never import a real wallet.</p></section>`
    : `${S.error ? `<p class="settings-status mono fork-error" role="alert">COULD NOT LOAD: ${esc(S.error)}</p>` : ""}${S.loading && !S.data.overview ? `<p class="settings-status mono" data-field="loading">LOADING FROM THE LOCAL FORK…</p>` : ""}${tabHtml(tab)}`;
  return `<section class="dashboard-shell wrap" data-fork-dashboard data-account="${acct?.address ?? ""}"><div class="dashboard-heading"><div><p class="hand">your private foundation</p><h1 class="pixel">DASHBOARD</h1></div><span class="preview-badge mono">LOCAL FORK · ${cfg.chainId}</span>${
    dev
      ? `<span class="preview-badge mono fork-dev-badge" data-dev-wallet-badge>DEV WALLET — local fork</span>`
      : ""
  }${wallet}</div><div class="dashboard-layout"><aside class="dashboard-nav" aria-label="Dashboard sections">${tabs
    .map(
      ([id, t, s]) =>
        `<a data-route href="/dashboard/${id === "overview" ? "" : id + "/"}" class="${tab === id ? "active" : ""}">${kit.icon(s!)}<span class="mono">${t}</span></a>`,
    )
    .join(
      "",
    )}<div class="account-note">${kit.logo()}<b>plynth</b><span class="mono">${acct ? esc(shortHash(acct.address)) : "NOT CONNECTED"}</span></div></aside><div class="dashboard-content">${body}<section class="dash-panel"><h2>Transactions</h2>${txLog()}</section><p class="dashboard-footnote">Local fork of Robinhood Chain (chain id ${cfg.chainId}). Nothing here touches a real network.</p></div></div></section>${kit.footer(false)}`;
}

// ---------------------------------------------------------------- events

const handlers: Record<string, () => void> = {
  connect: () => void run("Connect MetaMask", async () => void (await connectWallet("injected"))),
  "connect-dev": () =>
    void run("Connect dev wallet", async () => void (await connectWallet("dev"))),
  disconnect: () =>
    void disconnectWallet().then(() => ((S.data = {}), (S.loadedFor = ""), S.rerender())),
  attest: () => void run("Eligibility", (p) => A.attestEligibility(p)),
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
    void run("Save settings", (p) => A.saveSettings(s, p));
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
      S.loadedFor = "";
      S.data = {};
      S.rerender();
    });
    document.body.dataset.forkLoading = "1";
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
      if (a && !a.hasAttribute("disabled")) return handlers[a.dataset.action!]?.();
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
  });
}
