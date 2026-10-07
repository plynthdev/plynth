// Pure helpers for the live dashboard (no network, no wallet): unit-tested in logic.test.ts.
import type { Address } from "viem";

// ---------------------------------------------------------------- eligibility (mirrors backend app/src/eligibility/statement.ts)

export const STATEMENT_VERSION = 1;
export const STATEMENT =
  "I am not a person of the United States, the United Kingdom, Canada or Switzerland (not a resident, " +
  "citizen or entity there) and I do not act for one. I understand Stock Tokens are not offered to them.";

export function selfAttestationTypedData(chainId: number, wallet: Address, expiry: bigint) {
  return {
    domain: { name: "Plynth Eligibility", version: "1", chainId },
    types: {
      SelfAttestation: [
        { name: "wallet", type: "address" },
        { name: "statement", type: "string" },
        { name: "version", type: "uint32" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "SelfAttestation" as const,
    message: { wallet, statement: STATEMENT, version: STATEMENT_VERSION, expiry },
  };
}

/** The statement may be signed for at most a year; 300 days leaves room for fork time warps. */
export const ATTESTATION_TTL_S = 300 * 86_400;

// ---------------------------------------------------------------- round-up sources (mirrors backend routes/roundups.ts)

export function roundupMessage(m: {
  action: "import" | "link" | "unlink";
  user: Address;
  chainId: number;
  subject: string;
  issuedAt: number;
}): string {
  return [
    "Plynth round-up sources",
    `action: ${m.action}`,
    `user: ${m.user}`,
    `chain: ${m.chainId}`,
    `subject: ${m.subject}`,
    `issued: ${m.issuedAt}`,
  ].join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- amounts

const U = 1_000_000n;

/** "12.5" -> 12_500_000n (USDG, 6 decimals). Throws a sentence a person can act on. */
export function parseUsdg(s: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new Error("Enter an amount like 25 or 12.50 (at most 6 decimals).");
  const v = BigInt(m[1]!) * U + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (v === 0n) throw new Error("Amount must be more than 0.");
  return v;
}

/** 12_500_000n -> "12.5" (trailing zeros trimmed). */
export function formatUsdg(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % U).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / U}${frac ? `.${frac}` : ""}`;
}

/** API decimal strings ("2486.500000") -> "$2,486.50". */
export function money(s: string | number): string {
  const n = typeof s === "number" ? s : Number(s);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number.isFinite(n) ? n : 0,
  );
}

/** Raw token units (18 decimals by default) -> short decimal string. */
export function formatRaw(raw: string | bigint, decimals = 18, places = 6): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** "1.230000000000000000" -> "1.23"; at most `places` decimals, truncated. */
export function trimDecimals(s: string, places = 6): string {
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return s;
  const frac = (m[2] ?? "").slice(0, places).replace(/0+$/, "");
  return frac ? `${m[1]}.${frac}` : m[1]!;
}

// ---------------------------------------------------------------- mix

export type MixEntry = { token: Address; weightBps: number };

/** Percent inputs ({token: "50"}) -> a mix the vault accepts: 1-5 entries, whole bps, sum exactly 10000. */
export function mixFromPercents(rows: { token: Address; percent: string }[]): MixEntry[] {
  const mix = rows
    .map((r) => ({ token: r.token, weightBps: Math.round(Number(r.percent || "0") * 100) }))
    .filter((m) => m.weightBps !== 0);
  if (mix.some((m) => !Number.isFinite(m.weightBps) || m.weightBps < 0))
    throw new Error("Percentages must be positive numbers.");
  if (mix.length === 0) throw new Error("Choose at least one Stock Token.");
  if (mix.length > 5) throw new Error("Choose at most 5 Stock Tokens.");
  const sum = mix.reduce((a, m) => a + m.weightBps, 0);
  if (sum !== 10_000) throw new Error(`Percentages must add up to 100 (now ${sum / 100}).`);
  return mix;
}

// ---------------------------------------------------------------- chart

/** Habit points -> SVG polyline points in a width x height box (y grows down; top margin 10, bottom 20). */
export function chartPoints(values: number[], width = 600, height = 220): string {
  if (values.length === 0) return `0,${height - 20} ${width},${height - 20}`;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const n = values.length;
  return values
    .map((v, i) => {
      const x = n === 1 ? width : Math.round((i / (n - 1)) * width);
      const y = Math.round(height - 20 - ((v - min) / span) * (height - 40));
      return `${x},${y}`;
    })
    .join(" ");
}

// ---------------------------------------------------------------- modes

export const MODE_NAMES = { open: "Open", quiet: "Quiet", hidden: "Hidden" } as const;
export type ModeKey = keyof typeof MODE_NAMES;
export const modeKey = (name: string): ModeKey => {
  const k = name.toLowerCase();
  if (k !== "open" && k !== "quiet" && k !== "hidden")
    throw new Error("Choose Open, Quiet or Hidden.");
  return k;
};

/** HTML-escapes text from the API before it goes into innerHTML. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);

/** "Window 2 h · next opens 14:00 UTC" from the API's window (CrowdBuy.windowOf on chain): the length is the
 *  deployment's CrowdBuy.WINDOW (1 day on mainnet, 2 hours on testnet), never assumed. */
export function windowText(w: { start: string; end: string; next: string } | null | undefined): string {
  if (!w) return "Windows start at genesis";
  const secs = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 1000);
  const len = secs % 86_400 === 0 ? `${secs / 86_400} day${secs === 86_400 ? "" : "s"}` : secs % 3600 === 0 ? `${secs / 3600} h` : `${Math.round(secs / 60)} min`;
  const next = new Date(w.next).toISOString();
  const at = secs >= 86_400 ? `${next.slice(0, 10)} ${next.slice(11, 16)} UTC` : `${next.slice(11, 16)} UTC`;
  return `Window ${len} · next opens ${at}`;
}

// ---------------------------------------------------------------- network (todo 41: footer and badges never wrong)

export type NetworkKind = "fork" | "testnet" | "mainnet" | "other";
export type NetworkText = {
  kind: NetworkKind;
  /** Header badge, e.g. "LOCAL FORK · 31337". */
  badge: string;
  /** Short label for status lines, e.g. "LOCAL FORK". */
  short: string;
  /** The dashboard footnote. */
  footnote: string;
};

/** Every label that names the network comes from the configured chain id, so a testnet page never says "fork". */
export function networkText(chainId: number): NetworkText {
  if (chainId === 31337)
    return {
      kind: "fork",
      badge: "LOCAL FORK · 31337",
      short: "LOCAL FORK",
      footnote:
        "Local fork of Robinhood Chain (chain id 31337) on this computer. Nothing here touches a real network.",
    };
  if (chainId === 46630)
    return {
      kind: "testnet",
      badge: "ROBINHOOD CHAIN TESTNET · 46630",
      short: "TESTNET",
      footnote:
        "Robinhood Chain testnet (chain id 46630): test tokens only (mock USDG and mock Stock Tokens with no value), testnet ETH for gas.",
    };
  if (chainId === 4663)
    return {
      kind: "mainnet",
      badge: "ROBINHOOD CHAIN · 4663",
      short: "MAINNET",
      footnote: "Robinhood Chain mainnet (chain id 4663): real funds.",
    };
  return {
    kind: "other",
    badge: `CHAIN ${chainId}`,
    short: `CHAIN ${chainId}`,
    footnote: `Unknown network (chain id ${chainId}).`,
  };
}

// ---------------------------------------------------------------- allocation bar

export type AllocationSegment = {
  key: "stocks" | "park" | "usdg";
  label: string;
  usd: number;
  /** Width in percent (one decimal); every non-zero part is at least 1% wide so it stays visible. */
  pct: number;
};

/** Overview allocation -> coloured bar segments (zero parts dropped). Empty list = nothing held yet. */
export function allocationSegments(a: {
  stockTokensUsd?: string;
  parkUsd?: string;
  availableUsdg?: string;
} | undefined): AllocationSegment[] {
  const parts: Omit<AllocationSegment, "pct">[] = [
    { key: "stocks", label: "Stock tokens", usd: Number(a?.stockTokensUsd ?? 0) },
    { key: "park", label: "Private park", usd: Number(a?.parkUsd ?? 0) },
    { key: "usdg", label: "Available USDG", usd: Number(a?.availableUsdg ?? 0) },
  ].filter((p) => Number.isFinite(p.usd) && p.usd > 0) as Omit<AllocationSegment, "pct">[];
  const total = parts.reduce((s, p) => s + p.usd, 0);
  if (total <= 0) return [];
  return parts.map((p) => ({
    ...p,
    pct: Math.max(1, Math.round((p.usd / total) * 1000) / 10),
  }));
}

// ---------------------------------------------------------------- action gates (todo 41 item 4)

export type Gate = { ok: true } | { ok: false; reason: string };

/** Save Mix needs eligibility (SavingsVault.setMix reverts NotEligible otherwise). */
export function mixGate(eligible: boolean | undefined): Gate {
  if (!eligible)
    return {
      ok: false,
      reason: "Finish the eligibility self-attestation first: saving a buy mix reverts NotEligible without it.",
    };
  return { ok: true };
}

/** Join needs eligibility and pending round-ups (CrowdBuy.join reverts NotEligible / NothingPending). */
export function joinGate(eligible: boolean | undefined, pending: bigint | undefined): Gate {
  if (!eligible)
    return {
      ok: false,
      reason: "Finish the eligibility self-attestation first: joining reverts NotEligible without it.",
    };
  if (!pending)
    return {
      ok: false,
      reason: "No pending round-ups to join. Join only moves pending round-ups, never your available USDG.",
    };
  return { ok: true };
}

// ---------------------------------------------------------------- crowd buy timing (todo 41 item 5)

export type BookTiming = {
  symbol: string;
  accounts: number;
  minCrowd: number;
  executeAfter: string | null;
  executedThisWindow?: boolean | undefined;
};

const hhmm = (iso: string) => {
  const d = new Date(iso).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
};

/**
 * When a book is expected to execute: the revealed beacon time if there is one, otherwise the end of the current
 * window (the keeper reveals a jittered time inside it once the book has its crowd), or how many accounts it needs.
 */
export function bookTimingText(
  b: BookTiming,
  window: { start: string; end: string; next: string } | null | undefined,
): string {
  if (b.executedThisWindow) return `executed this window; next book opens for ${window ? hhmm(window.end) : "the next window"}`;
  if (b.accounts < b.minCrowd)
    return `needs ${b.minCrowd - b.accounts} more account(s) to reach the minimum crowd of ${b.minCrowd}`;
  if (b.executeAfter) return `executes after ${hhmm(b.executeAfter)} (the beacon's revealed time)`;
  return window
    ? `executes at a jittered time before ${hhmm(window.end)} (revealed by the keeper's beacon)`
    : "executes once the first window opens";
}

// ---------------------------------------------------------------- transactions panel (todo 41 item 6)

export type TxLine = { msg: string; hash: string };
export type LogEntry = {
  id: number;
  label: string;
  state: "running" | "ok" | "error";
  msg: string;
  /** The transaction currently waiting for its receipt (shown on the action's line only until it confirms). */
  pending?: string | undefined;
  /** Every confirmed transaction of this action, each listed exactly once. */
  txs: TxLine[];
};

/** Records progress on an action's entry: a confirmed hash moves from `pending` to `txs` (once, even if repeated). */
export function recordProgress(entry: LogEntry, msg: string, hash?: string): void {
  if (hash && /confirmed/.test(msg)) {
    entry.pending = undefined;
    if (!entry.txs.some((t) => t.hash === hash)) entry.txs.push({ msg, hash });
    entry.msg = `${entry.txs.length} transaction${entry.txs.length === 1 ? "" : "s"} confirmed`;
    return;
  }
  entry.msg = msg;
  entry.pending = hash;
}

/** The Transactions panel: one line per action, its confirmed transactions nested under it, each once. */
export function renderTxLog(entries: LogEntry[], emptyText: string): string {
  if (!entries.length)
    return `<p class="settings-status mono" id="fork-status" aria-live="polite">${esc(emptyText)}</p>`;
  return `<ol class="fork-log" id="fork-log" aria-live="polite">${entries
    .map((l) => {
      const st = l.state === "running" ? "…" : l.state === "ok" ? "OK" : "ERROR";
      const pend = l.pending ? ` <code title="${esc(l.pending)}">${shortHash(l.pending)}</code>` : "";
      const txs = l.txs.length
        ? `<ul class="fork-txs">${l.txs
            .map(
              (t) =>
                `<li data-tx-hash="${esc(t.hash)}">${esc(t.msg)} <code title="${esc(t.hash)}">${shortHash(t.hash)}</code></li>`,
            )
            .join("")}</ul>`
        : "";
      return `<li data-state="${l.state}" data-label="${esc(l.label)}"><span class="mono">${st}</span> <b>${esc(l.label)}</b> <span data-msg>${esc(l.msg)}</span>${pend}${txs}</li>`;
    })
    .join("")}</ol>`;
}

// ---------------------------------------------------------------- settings read-back (todo 41 item 8)

/** True once the API reports the settings that were just saved (a lagging RPC node can serve the old block). */
export function settingsMatch(
  saved: { roundTo: number; multiplier: number; weeklyCap: string; fixedTopUp: string; mode: string },
  read: { roundTo: number; multiplier: number; weeklyCap: string; fixedTopUp: string; mode: string } | undefined,
): boolean {
  if (!read) return false;
  return (
    read.roundTo === saved.roundTo &&
    read.multiplier === saved.multiplier &&
    Number(read.weeklyCap) === Number(saved.weeklyCap) &&
    Number(read.fixedTopUp) === Number(saved.fixedTopUp) &&
    read.mode === saved.mode
  );
}
