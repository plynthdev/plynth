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
