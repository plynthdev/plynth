// Hono app: tRPC at /trpc/*, a REST mirror of the same procedures at /v1/*, CORS from an allow-list.
// The REST mirror calls the same tRPC procedures (createCaller), so its JSON body is exactly the tRPC
// result data.
import { trpcServer } from "@hono/trpc-server";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { appRouter, type Ctx } from "./router";
import type { Deps } from "./service";

export const DEFAULT_CORS_ORIGINS = ["https://plynthlations.lovable.app", "http://localhost:5173"];

/** CORS_ORIGINS: comma-separated exact origins. Unset or empty -> the defaults. */
export function corsOrigins(env: string | undefined): string[] {
  const list = (env ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  return list.length ? list : DEFAULT_CORS_ORIGINS;
}

type Proc = { method: "GET" | "POST"; path: string; call: (caller: ReturnType<typeof appRouter.createCaller>, c: Context) => Promise<unknown> };

const q = (c: Context) => c.req.query();
async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "body must be JSON" });
  }
}

/** REST mirror: every procedure, same input names (path params for the account address). */
export const REST: Proc[] = [
  { method: "GET", path: "/v1/account/:address/overview", call: (k, c) => k.account.overview({ address: c.req.param("address")! }) },
  { method: "GET", path: "/v1/account/:address/habit", call: (k, c) => k.account.habit({ address: c.req.param("address")!, ...q(c) } as any) },
  { method: "GET", path: "/v1/account/:address/activity", call: (k, c) => k.account.activity({ address: c.req.param("address")!, ...q(c) } as any) },
  { method: "GET", path: "/v1/account/:address/settings", call: (k, c) => k.account.settings({ address: c.req.param("address")! }) },
  { method: "POST", path: "/v1/tx/setSettings", call: async (k, c) => k.tx.setSettings((await body(c)) as any) },
  { method: "POST", path: "/v1/tx/approveUsdg", call: async (k, c) => k.tx.approveUsdg((await body(c)) as any) },
  { method: "POST", path: "/v1/tx/deposit", call: async (k, c) => k.tx.deposit((await body(c)) as any) },
  { method: "POST", path: "/v1/tx/withdraw", call: async (k, c) => k.tx.withdraw((await body(c)) as any) },
  { method: "POST", path: "/v1/tx/setMix", call: async (k, c) => k.tx.setMix((await body(c)) as any) },
  { method: "POST", path: "/v1/tx/claimOpen", call: async (k, c) => k.tx.claimOpen((await body(c)) as any) },
  { method: "GET", path: "/v1/crowd/books", call: (k, c) => k.crowd.books(q(c) as any) },
  { method: "GET", path: "/v1/statements/:address", call: (k, c) => k.statements.list({ address: c.req.param("address")! }) },
  { method: "POST", path: "/v1/statements/verify", call: async (k, c) => k.statements.verify({ bundle: await body(c) }) },
  { method: "POST", path: "/v1/proofs/verify", call: async (k, c) => k.proofs.verify((await body(c)) as any) },
  { method: "POST", path: "/proofs/verify", call: async (k, c) => k.proofs.verify((await body(c)) as any) },
  { method: "GET", path: "/v1/proofs/nonce", call: (k, c) => k.proofs.nonce(q(c) as any) },
  { method: "GET", path: "/v1/treasury/templates", call: (k) => k.treasury.templates() },
  { method: "GET", path: "/v1/treasury/marketplace", call: (k) => k.marketplace.list() },
  { method: "GET", path: "/v1/treasury/:account/receipts/:hour", call: (k, c) => k.receipts.root({ account: c.req.param("account")!, hour: c.req.param("hour") } as any) },
  { method: "GET", path: "/v1/treasury/:account/actions/:actionId/proof", call: (k, c) => k.receipts.proof({ account: c.req.param("account")!, actionId: c.req.param("actionId") } as any) },
  { method: "GET", path: "/v1/treasury/:account/mcp-tokens", call: (k, c) => k.mcpTokens.list({ account: c.req.param("account")! }) },
  { method: "POST", path: "/v1/treasury/:account/mcp-tokens", call: async (k, c) => k.mcpTokens.issue({ ...(await body(c)), account: c.req.param("account")! } as any) },
  { method: "POST", path: "/v1/treasury/:account/mcp-tokens/:id/revoke", call: async (k, c) => k.mcpTokens.revoke({ ...(await body(c)), account: c.req.param("account")!, id: c.req.param("id") } as any) },
  { method: "POST", path: "/v1/treasury/create", call: async (k, c) => k.treasury.create((await body(c)) as any) },
  { method: "GET", path: "/v1/treasury/:account/policy", call: (k, c) => k.policy.current({ account: c.req.param("account")! }) },
  { method: "POST", path: "/v1/treasury/:account/policy/diff", call: async (k, c) => k.policy.diff({ ...(await body(c)), account: c.req.param("account")! } as any) },
  { method: "POST", path: "/v1/treasury/:account/policy/propose", call: async (k, c) => k.policy.propose({ ...(await body(c)), account: c.req.param("account")! } as any) },
  { method: "GET", path: "/v1/treasury/:account/desks", call: (k, c) => k.desk.list({ account: c.req.param("account")! }) },
  { method: "GET", path: "/v1/treasury/:account/nav", call: (k, c) => k.nav.latest({ account: c.req.param("account")! }) },
  { method: "GET", path: "/v1/treasury/:account/nav/history", call: (k, c) => k.nav.history({ ...q(c), account: c.req.param("account")! } as any) },
  { method: "GET", path: "/v1/treasury/:account/positions", call: (k, c) => k.positions.list({ account: c.req.param("account")! }) },
  { method: "GET", path: "/v1/treasury/:account/actions", call: (k, c) => k.actions.list({ ...q(c), account: c.req.param("account")! } as any) },
  { method: "GET", path: "/v1/treasury/:account/exceptions", call: (k, c) => k.exceptions.list({ ...q(c), account: c.req.param("account")! } as any) },
  { method: "GET", path: "/v1/treasury/:account/closes", call: (k, c) => k.close.list({ account: c.req.param("account")! }) },
  { method: "GET", path: "/v1/treasury/:account/closes/:index", call: (k, c) => k.close.get({ account: c.req.param("account")!, index: c.req.param("index") } as any) },
  { method: "GET", path: "/v1/treasury/:account/cfo-pack/:periodEnd", call: (k, c) => k.cfo.pack({ ...q(c), account: c.req.param("account")!, periodEnd: c.req.param("periodEnd") } as any) },
  { method: "GET", path: "/v1/meta/eligibility", call: (k) => k.meta.eligibility() },
  { method: "GET", path: "/v1/meta/health", call: (k) => k.meta.health() },
];

/**
 * opts.eligibility: the screening routes from @plynth/eligibility (eligibilityFromEnv(...).routes). When given,
 * they are served at /eligibility/check and /v1/eligibility/check behind the same CORS allow-list.
 * opts.roundups: the round-up source routes (roundupsFromEnv), served at /roundups/* and /v1/roundups/*.
 */
export function createApp(deps: Deps, opts: { corsOrigins?: string[] | undefined; eligibility?: Hono | undefined; roundups?: Hono | undefined } = {}): Hono {
  const allowed = new Set(opts.corsOrigins ?? DEFAULT_CORS_ORIGINS);
  const app = new Hono();

  // Unknown browser origins are refused outright (403), not just left without CORS headers.
  // Requests without an Origin header (curl, servers) are not browser cross-origin calls and pass.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !allowed.has(origin)) return c.json({ error: "origin not allowed" }, 403);
    await next();
  });
  app.use("*", cors({ origin: (o) => (allowed.has(o) ? o : null), allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "x-plynth-residency"], maxAge: 600 }));

  const ctxOf = (c: Context): Ctx => ({ ...deps, headers: c.req.raw.headers });

  app.use("/trpc/*", trpcServer({ router: appRouter, endpoint: "/trpc", createContext: (_o, c) => ctxOf(c) }));

  for (const p of REST) {
    const handler = async (c: Context) => {
      try {
        const data = await p.call(appRouter.createCaller(ctxOf(c)), c);
        const status = p.path === "/v1/meta/health" && !(data as { ok: boolean }).ok ? 503 : 200;
        return c.json(data as object, status);
      } catch (e) {
        const err = e instanceof TRPCError ? e : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: e });
        const status = getHTTPStatusCodeFromError(err);
        // The client only sees "internal error"; the operator needs the cause.
        if (status >= 500) console.error(`[api] ${p.method} ${p.path}: ${err.cause instanceof Error ? (err.cause.stack ?? err.cause.message) : err.message}`);
        const message = status >= 500 ? "internal error" : err.message;
        return c.json({ error: { code: err.code, message } }, status as 400);
      }
    };
    if (p.method === "GET") app.get(p.path, handler);
    else app.post(p.path, handler);
  }
  // The CFO pack as a file (same procedure as /v1/treasury/:account/cfo-pack/:periodEnd, body unwrapped).
  app.get("/v1/treasury/:account/cfo-pack/:periodEnd/download", async (c) => {
    try {
      const p = await appRouter.createCaller(ctxOf(c)).cfo.pack({ ...q(c), account: c.req.param("account")!, periodEnd: c.req.param("periodEnd") } as any);
      return c.body(p.body, 200, { "content-type": p.contentType, "content-disposition": `attachment; filename="${p.filename}"` });
    } catch (e) {
      const err = e instanceof TRPCError ? e : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: e });
      const status = getHTTPStatusCodeFromError(err);
      return c.json({ error: { code: err.code, message: status >= 500 ? "internal error" : err.message } }, status as 400);
    }
  });
  if (opts.eligibility) {
    app.route("/eligibility", opts.eligibility);
    app.route("/v1/eligibility", opts.eligibility);
  }
  if (opts.roundups) {
    app.route("/roundups", opts.roundups);
    app.route("/v1/roundups", opts.roundups);
  }
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));
  return app;
}
