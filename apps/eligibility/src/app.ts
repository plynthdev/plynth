// HTTP: POST /eligibility/check {address, attestationSig, expiry} -> a signed registry attestation or a reason.
// Rate-limited per client IP and per address, in memory. The IP is used for the country lookup and the
// rate-limit key only; it is never written to the database or logs.
import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { isAddress, isHex, type Address, type Hex } from "viem";
import type { EligibilityService } from "./service";

/** Sliding-window counter per key, in memory (one process). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    const ok = xs.length < this.limit;
    if (ok) xs.push(t);
    this.hits.set(key, xs);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
    return ok;
  }
}

export type RouteOpts = {
  /** Behind Cloudflare (or another proxy that sets these): trust CF-IPCountry and CF-Connecting-IP / X-Forwarded-For. */
  trustProxy?: boolean;
  perIp?: RateLimiter;
  perAddress?: RateLimiter;
  /** Overrides how the client IP is found (tests). */
  clientIp?: (c: Context) => string | null;
};

export function clientIpOf(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const cf = c.req.header("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** Mount with app.route("/eligibility", eligibilityRoutes(...)). */
export function eligibilityRoutes(service: EligibilityService, opts: RouteOpts = {}): Hono {
  const trustProxy = opts.trustProxy ?? false;
  const perIp = opts.perIp ?? new RateLimiter(10, 60_000);
  const perAddress = opts.perAddress ?? new RateLimiter(5, 60_000);
  const app = new Hono();

  app.post("/check", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const { address, attestationSig, expiry } = body;
    if (typeof address !== "string" || !isAddress(address, { strict: false })) return c.json({ error: "bad address" }, 400);
    if (typeof attestationSig !== "string" || !isHex(attestationSig) || attestationSig.length < 4) return c.json({ error: "bad attestationSig" }, 400);
    if ((typeof expiry !== "string" && typeof expiry !== "number") || !/^\d{1,20}$/.test(String(expiry))) return c.json({ error: "bad expiry" }, 400);

    const ip = opts.clientIp ? opts.clientIp(c) : clientIpOf(c, trustProxy);
    if (!perIp.take(`ip:${ip ?? "none"}`) || !perAddress.take(`a:${address.toLowerCase()}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const d = await service.check({
      address: address as Address,
      attestationSig: attestationSig as Hex,
      statementExpiry: BigInt(String(expiry)),
      ip,
      cfCountry: trustProxy ? (c.req.header("cf-ipcountry") ?? null) : null,
    });
    if (!d.allowed) return c.json({ allowed: false, reason: d.reason });
    // Submit with EligibilityRegistry.attest(user, issuedAt, expiry, flags, signature); anyone may send it.
    return c.json({ allowed: true, attestation: d.attestation });
  });
  return app;
}
