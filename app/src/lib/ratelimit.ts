import { isIPv4, isIPv6 } from "node:net";

/**
 * The rate-limit key of a client address: an IPv4 address as is (also when IPv4-mapped, ::ffff:a.b.c.d), an IPv6
 * address by its /64. One subscriber normally gets a whole /64, so keying single IPv6 addresses would hand an attacker
 * 2^64 fresh limits (audit M-8). Anything unparseable is its own key.
 */
export function ipKey(ip: string): string {
  const a = ip.trim().replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return a;
  let groups: string[];
  const tail = a.match(/:(\d+\.\d+\.\d+\.\d+)$/); // embedded IPv4 in the last 32 bits: not part of the /64
  const head = tail ? a.slice(0, a.length - tail[1]!.length) + "0:0" : a;
  if (head.includes("::")) {
    const [l, r] = head.split("::") as [string, string];
    const left = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  } else groups = head.split(":");
  return `${groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** Sliding-window counter per key, in memory (one process: the relayer, or the API). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if it is within the limit. */
  take(key: string): boolean {
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (xs.length >= this.limit) {
      this.hits.set(key, xs);
      return false;
    }
    xs.push(t);
    this.hits.set(key, xs);
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, xs] of this.hits) if (!xs.some((x) => x > t - this.windowMs)) this.hits.delete(k);
  }
}

/**
 * The client address of a request: with `trustProxy`, the first X-Forwarded-For hop (Caddy replaces any value a
 * client sends with the real address, see scripts/server/Caddyfile); else the socket address `remote` gives.
 */
export function clientIp(headers: { get(name: string): string | null | undefined }, trustProxy: boolean, remote: () => string | undefined): string {
  if (trustProxy) return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return remote() ?? "unknown";
}
