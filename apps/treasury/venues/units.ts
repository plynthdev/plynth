// Exact decimal <-> bigint conversions between venue numbers (decimal strings or JSON numbers, in shares and
// dollars) and chain units (Stock Token base units, USD 1e18). No floats past parsing a JSON number's text.
const E18 = 10n ** 18n;

/** "123.45" / 123.45 / "-0.5" / "1e-5" -> value x 10^decimals, truncated toward zero. */
export function toFixed(v: string | number, decimals: number): bigint {
  let s = typeof v === "number" ? numberText(v) : v.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "-" || s === ".") throw new Error(`not a decimal: ${String(v)}`);
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [int = "0", frac = ""] = s.split(".");
  const f = (frac + "0".repeat(decimals)).slice(0, decimals);
  const out = BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt(f || "0");
  return neg ? -out : out;
}

/** Plain digits for a JS number (no exponent), e.g. 1e-7 -> "0.0000001". */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not finite: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/** bigint x 10^-decimals as a decimal string without trailing zeros. */
export function fromFixed(x: bigint, decimals: number): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const base = 10n ** BigInt(decimals);
  const int = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Venue shares (1e18 fixed) -> Stock Token base units (18 dp): tokens = shares / multiplier. */
export const sharesToTokens = (shares18: bigint, multiplier: bigint) => (shares18 * E18) / multiplier;

/** Stock Token base units -> shares (1e18 fixed). */
export const tokensToShares = (tokens: bigint, multiplier: bigint) => (tokens * multiplier) / E18;

/** A funding rate per `intervalSec` (decimal) -> signed 1e18 fraction per second. */
export const ratePerSecond = (rate: string | number, intervalSec: number) => toFixed(rate, 18) / BigInt(intervalSec);

/** Rounds `x` down to a multiple of `step` (both > 0). */
export const floorTo = (x: bigint, step: bigint) => (x / step) * step;
