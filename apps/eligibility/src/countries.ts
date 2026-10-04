// Stock Tokens are not offered to US, UK, Canadian or Swiss persons. Those four are refused by every source.

export const BLOCKED_COUNTRIES = ["US", "GB", "CA", "CH"] as const;

/** Cloudflare's codes that are not countries: T1 = Tor exit, XX = unknown. Treated as "no country". */
const NOT_A_COUNTRY = new Set(["T1", "XX"]);

/** ISO 3166-1 alpha-2, upper-case; "UK" is mapped to "GB". Anything else is null. */
export function normCountry(v: string | null | undefined): string | null {
  if (!v) return null;
  const c = v.trim().toUpperCase();
  if (c === "UK") return "GB";
  if (NOT_A_COUNTRY.has(c)) return null;
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

export function isBlockedCountry(c: string | null): boolean {
  return c !== null && (BLOCKED_COUNTRIES as readonly string[]).includes(c);
}
