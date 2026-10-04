/** JSON-safe copy: bigint -> decimal string (jsonb cannot hold bigint, and JS numbers lose precision). */
export function toJsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJsonSafe(x);
    return out;
  }
  return v;
}
