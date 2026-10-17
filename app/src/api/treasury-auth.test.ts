// Review v2, V2-L15 (API-2): L-14 gated /actions behind an MCP token, but the same desk decisions, with their
// free-text reasons, were served without any token by GET /v1/treasury/:account/closes/:index (from the close bundle),
// the close list (pending rows), the CFO pack and the desk list. Treasury reads are now default-deny: a route-table
// test walks every procedure and every REST route.
import { describe, expect, test } from "bun:test";
import { BlockTimes, createApp, REST } from "@/api";
import { appRouter, isTreasuryPrivate, TREASURY_PUBLIC } from "@/api/router";

// (The PoC stubbed loadStatement with mock.module to return a committed bundle holding this reason. The gate now runs
// before any treasury code, so no stub is needed, and mock.module would leak into every other test file.)
const SECRET_REASON = "selling NVDA ahead of the board's undisclosed M&A news";

const ONE = "0x00000000000000000000000000000000000000b1";
const ACCT = "0x00000000000000000000000000000000000000a5";
function app() {
  const pub = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "closeCount") return 1n;
      if (functionName === "closeAt") return { periodEnd: 1n, navUsd: 1n, positionsHash: `0x${"00".repeat(32)}`, bundleHash: `0x${"22".repeat(32)}`, policyHash: `0x${"00".repeat(32)}`, policyVersion: 1 };
      return ONE;
    },
    getBlockNumber: async () => 10n,
    getContractEvents: async () => [],
  } as any;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }) }) }) } as any;
  return createApp({ chainId: 4663, pub, db, dep: { deployBlock: 1n, stocks: [] } as any, blockTimes: new BlockTimes(pub), mcpSecret: "x".repeat(40) }, { ipOf: () => "203.0.113.9" });
}

describe("V2-L15: treasury records are default-deny", () => {
  test("close.get without a token is 401 and does not leak the desk's reason", async () => {
    const a = app();
    const actions = await a.request(`/v1/treasury/${ACCT}/actions`);
    const close = await a.request(`/v1/treasury/${ACCT}/closes/0`);
    expect(actions.status).toBe(401);
    expect(close.status).toBe(401);
    expect((await close.text()).includes(SECRET_REASON)).toBe(false);
    for (const p of [`/v1/treasury/${ACCT}/closes`, `/v1/treasury/${ACCT}/desks`, `/v1/treasury/${ACCT}/cfo-pack/1`, `/v1/treasury/${ACCT}/cfo-pack/1/download`]) {
      const r = await a.request(p);
      expect(r.status, p).toBe(401);
      expect((await r.text()).includes(SECRET_REASON), p).toBe(false);
    }
    expect((await a.request(`/v1/treasury/${ACCT}/closes/0`, { headers: { authorization: "Bearer pmcp_forged.AAAA" } })).status).toBe(401);
  });

  test("route table: every treasury procedure is either listed public or answers 401 without a token", async () => {
    const procs = Object.keys((appRouter as any)._def.procedures as Record<string, unknown>);
    const treasuryProcs = procs.filter((p) => ["treasury", "policy", "desk", "nav", "receipts", "marketplace", "mcpTokens", "positions", "actions", "exceptions", "close", "cfo"].includes(p.split(".")[0]!));
    expect(treasuryProcs.length).toBeGreaterThan(15);
    for (const p of TREASURY_PUBLIC) expect(procs, p).toContain(p); // no stale public entries
    // exactly these are public; anything new in a treasury namespace is private by default
    expect([...TREASURY_PUBLIC].sort()).toEqual(
      ["marketplace.list", "mcpTokens.issue", "mcpTokens.revoke", "nav.history", "nav.latest", "policy.current", "policy.diff", "policy.propose", "positions.list", "receipts.root", "treasury.create", "treasury.templates"].sort(),
    );
    const a = app();
    for (const p of treasuryProcs.filter(isTreasuryPrivate)) {
      const r = await a.request(`/trpc/${p}?input=${encodeURIComponent(JSON.stringify({ account: ACCT, index: 0, periodEnd: "1", actionId: 1 }))}`);
      const r2 = await a.request(`/trpc/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: ACCT }) });
      expect([r.status, r2.status].includes(401), p).toBe(true);
      expect([r.status, r2.status].every((s) => s === 401 || s === 405), p).toBe(true);
    }
  });

  test("route table: every REST route with an :account is public by the list above or 401 without a token", async () => {
    const PUBLIC_REST = new Set([
      "GET /v1/treasury/:account/policy",
      "POST /v1/treasury/:account/policy/diff",
      "POST /v1/treasury/:account/policy/propose",
      "GET /v1/treasury/:account/nav",
      "GET /v1/treasury/:account/nav/history",
      "GET /v1/treasury/:account/positions",
      "GET /v1/treasury/:account/receipts/:hour",
      "POST /v1/treasury/:account/mcp-tokens",
      "POST /v1/treasury/:account/mcp-tokens/:id/revoke",
    ]);
    const a = app();
    const routes = REST.filter((r) => r.path.includes(":account"));
    expect(routes.length).toBeGreaterThan(15);
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      const path = r.path.replace(":account", ACCT).replace(":index", "0").replace(":periodEnd", "1").replace(":actionId", "1").replace(":hour", "1").replace(":id", "ab".repeat(16));
      const res = await a.request(path, r.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {});
      if (PUBLIC_REST.has(key)) expect(res.status, key).not.toBe(401);
      else expect(res.status, key).toBe(401);
    }
    for (const k of PUBLIC_REST) expect(routes.map((r) => `${r.method} ${r.path}`), k).toContain(k);
  });
});
