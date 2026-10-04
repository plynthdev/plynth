// Money is returned as decimal strings (never JS numbers: they lose precision past 2^53).
export const USDG_DECIMALS = 6;
/** USD values are 1e18 on-chain (Valuer); the API prints them with 6 decimals, truncated. */
export const USD_DECIMALS = 18;
export const OUT_DECIMALS = 6;

/** Fixed-point bigint -> decimal string with exactly `places` decimals, truncated toward zero. */
export function fixed(x: bigint, decimals: number, places = OUT_DECIMALS): string {
  const neg = x < 0n;
  let v = neg ? -x : x;
  if (decimals > places) v /= 10n ** BigInt(decimals - places);
  else if (decimals < places) v *= 10n ** BigInt(places - decimals);
  const s = v.toString().padStart(places + 1, "0");
  const out = places === 0 ? s : `${s.slice(0, -places)}.${s.slice(-places)}`;
  return neg && v !== 0n ? `-${out}` : out;
}

export const usdg = (x: bigint) => fixed(x, USDG_DECIMALS);
export const usd = (x1e18: bigint) => fixed(x1e18, USD_DECIMALS);
/** USDG base units -> 1e18 USD at par (USDG is treated as 1 USD; its Chainlink feed is not consulted here). */
export const usdgToUsd18 = (x: bigint) => x * 10n ** BigInt(USD_DECIMALS - USDG_DECIMALS);

/** "12.5" -> 12_500_000n for 6 decimals. Rejects more decimals than the token has, signs and exponents. */
export function parseAmount(s: string, decimals = USDG_DECIMALS): bigint {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad amount: ${s}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`too many decimals (max ${decimals}): ${s}`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export const iso = (unixSeconds: bigint | number) => new Date(Number(unixSeconds) * 1000).toISOString();
export const day = (unixSeconds: bigint | number) => iso(unixSeconds).slice(0, 10);
