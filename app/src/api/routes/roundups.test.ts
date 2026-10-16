// Todo 23: POST /v1/roundups/* (statement import, Plaid link/exchange, unlink) against Postgres, with Plaid
// mocked at HTTP level (msw). Every request must carry a fresh wallet signature of roundupMessage.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { Sealer, plaidAad, sha256Hex } from "@/keeper";
import { privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "@/lib/ratelimit";
import { BlockTimes, createApp, roundupMessage, roundupRoutes, roundupsFromEnv, SIGNATURE_MAX_AGE_S, type RoundupAction } from "@/api";
import { keeperTestDb } from "@/testing/keeper-helpers";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // test-key (anvil #1)
const bob = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key (anvil #3)
const mallory = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // test-key (anvil #2)
const CHAIN = 31337;
const fx = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "testing", "fixtures", "keeper", f), "utf8");

const plaidCalls: { path: string; body: any }[] = [];
const server = setupServer(
  http.post(`${PlaidEnvironments.sandbox}/link/token/create`, async ({ request }) => {
    const body = await request.json();
    plaidCalls.push({ path: "link", body });
    return HttpResponse.json({ link_token: "link-sandbox-abc", expiration: "2026-10-04T12:00:00Z", request_id: "r" });
  }),
  http.post(`${PlaidEnvironments.sandbox}/item/public_token/exchange`, async ({ request }) => {
    const body = (await request.json()) as any;
    plaidCalls.push({ path: "exchange", body });
    if (body.public_token !== "public-sandbox-1") return HttpResponse.json({ error_code: "INVALID_PUBLIC_TOKEN" }, { status: 400 });
    return HttpResponse.json({ access_token: "access-sandbox-secret", item_id: "item-77", request_id: "r" });
  }),
  http.post(`${PlaidEnvironments.sandbox}/item/remove`, async ({ request }) => {
    plaidCalls.push({ path: "remove", body: await request.json() });
    return HttpResponse.json({ request_id: "r" });
  }),
);

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let sealer: Sealer;
let app: ReturnType<typeof createApp>;
let noPlaid: ReturnType<typeof roundupRoutes>;
const nowS = () => Math.floor(Date.now() / 1000);

async function signed(action: RoundupAction, subject: string, extra: Record<string, unknown>, who = alice, issuedAt = nowS(), user = alice.address) {
  const signature = await who.signMessage({ message: roundupMessage({ action, user, chainId: CHAIN, subject, issuedAt }) });
  return { user, issuedAt, signature, ...extra };
}
const post = (path: string, body: unknown, a: { request: (p: string, i: RequestInit) => Response | Promise<Response> } = app) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "bypass" });
  t = await keeperTestDb("api_roundups");
  sealer = await Sealer.create(crypto.getRandomValues(new Uint8Array(32)));
  const plaid = new PlaidApi(new Configuration({ basePath: PlaidEnvironments.sandbox!, baseOptions: { headers: { "PLAID-CLIENT-ID": "c", "PLAID-SECRET": "s" } } }));
  const noChain = new Proxy({}, { get: () => () => Promise.reject(new Error("no chain")) }) as any;
  const roundups = roundupRoutes({ chainId: CHAIN, db: t.db, plaid: { api: plaid, env: "sandbox", countryCodes: ["US"] }, sealer });
  app = createApp({ chainId: CHAIN, pub: noChain, db: t.db, dep: {} as any, blockTimes: new BlockTimes(noChain) }, { roundups });
  noPlaid = roundupRoutes({ chainId: CHAIN, db: t.db });
});
afterAll(async () => {
  server.close();
  await t?.drop();
});

describe("POST /v1/roundups/import", () => {
  test("imports a signed CSV: spends stored, credits and bad rows reported with reasons, source linked", async () => {
    const content = fx("chase.csv");
    const r = await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ format: "csv", layout: "chase", rows: 7, imported: 4, duplicates: 0 });
    expect(j.skipped).toEqual([
      { line: 5, reason: "credit, not a spend" },
      { line: 6, reason: "credit, not a spend" },
      { line: 8, reason: "unreadable amount" },
    ]);
    const rows = await t.sql`select amount_cents, status, source from roundup_events where user_address = ${alice.address.toLowerCase()} order by at, row_hash`;
    expect(rows.map((x) => Number(x.amount_cents)).sort((a, b) => a - b)).toEqual([275, 435, 435, 5210]);
    expect(rows.every((x) => x.status === "new" && x.source === "statement")).toBe(true);
    const [src] = await t.sql`select kind, source_key, status from roundup_sources where user_address = ${alice.address.toLowerCase()}`;
    expect(src).toEqual({ kind: "statement", source_key: "statement", status: "active" });
  });

  test("dedupe: the same statement again (also on the /roundups alias) imports nothing", async () => {
    const content = fx("chase.csv");
    const r = await post("/roundups/import", await signed("import", sha256Hex(content), { content }));
    expect(await r.json()).toMatchObject({ imported: 0, duplicates: 4 });
  });

  test("OFX/QFX upload; non-USD rows are skipped with a reason", async () => {
    const content = fx("bank.qfx");
    const j = (await (await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content }))).json()) as any;
    expect(j).toMatchObject({ format: "ofx", imported: 2 });
    expect(j.skipped.map((s: any) => s.reason)).toEqual(["credit, not a spend", "currency EUR is not USD"]);
  });

  test("debitSign and layout options; bad options and unparseable files are 400", async () => {
    const content = "Date,Description,Amount\n2026-09-01,Shop,12.34\n";
    const ok = (await (await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content, debitSign: "positive" }))).json()) as any;
    expect(ok).toMatchObject({ layout: "generic/positive", imported: 1 });
    expect((await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content, debitSign: "up" }))).status).toBe(400);
    expect((await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content, format: "pdf" }))).status).toBe(400);
    const junk = "hello,world\n1,2\n";
    const r = await post("/v1/roundups/import", await signed("import", sha256Hex(junk), { content: junk }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toMatch(/header/);
  });

  test("someone else's signature, a signature over other content, and a stale signature are 401", async () => {
    const content = fx("capitalone.csv");
    expect((await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content }, mallory))).status).toBe(401);
    expect((await post("/v1/roundups/import", await signed("import", sha256Hex("other"), { content }))).status).toBe(401);
    expect((await post("/v1/roundups/import", await signed("import", sha256Hex(content), { content }, alice, nowS() - SIGNATURE_MAX_AGE_S - 5))).status).toBe(401);
    expect((await post("/v1/roundups/import", await signed("unlink", sha256Hex(content), { content }))).status).toBe(401); // wrong action
    expect((await post("/v1/roundups/import", { content, user: "nope", issuedAt: nowS(), signature: "0x" })).status).toBe(400);
    const n = await t.sql`select count(*)::int as n from roundup_events where amount_cents = 1999`;
    expect(n[0]!.n).toBe(0);
  });

  test("audit M-7: new rows per user per 7 days are capped (re-imports of known rows still pass)", async () => {
    const capped = roundupRoutes({ chainId: CHAIN, db: t.db, maxRowsPerWeek: 5 });
    const csv = (n: number, from = 0) => `Date,Description,Amount\n${Array.from({ length: n }, (_, i) => `2026-09-01,Shop ${from + i},-1.${String(from + i).padStart(2, "0")}`).join("\n")}\n`;
    const first = csv(4);
    const ok = await post("/import", await signed("import", sha256Hex(first), { content: first }, mallory, nowS(), mallory.address), capped);
    expect(((await ok.json()) as any).imported).toBe(4);
    const more = csv(3, 4);
    const r = await post("/import", await signed("import", sha256Hex(more), { content: more }, mallory, nowS(), mallory.address), capped);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.message).toMatch(/at most 5 new statement rows per 7 days/);
    const again = await post("/import", await signed("import", sha256Hex(first), { content: first }, mallory, nowS(), mallory.address), capped);
    expect(await again.json()).toMatchObject({ imported: 0, duplicates: 4 });
    const one = csv(1, 4);
    expect((await post("/import", await signed("import", sha256Hex(one), { content: one }, mallory, nowS(), mallory.address), capped)).status).toBe(200);
  });

  test("audit M-9: a 20,000-row OFX upload through the route answers in well under a second (was ~57 s)", async () => {
    const big = roundupRoutes({ chainId: CHAIN, db: t.db, maxRowsPerWeek: 50_000 });
    const head = "OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n<STMTRS>\n<CURDEF>USD\n<BANKTRANLIST>\n";
    const rows = Array.from({ length: 20_000 }, (_, i) => `<STMTTRN>\n<DTPOSTED>20260915\n<TRNAMT>-0.00\n<FITID>${i}\n</STMTTRN>\n`).join("");
    const content = `${head}${rows}</BANKTRANLIST>\n</STMTRS>\n</OFX>\n`; // zero amounts: parsed in full, nothing stored
    const body = await signed("import", sha256Hex(content), { content }, mallory, nowS(), mallory.address);
    const t0 = performance.now();
    const r = await post("/import", body, big);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).rows).toBe(20_000);
    expect(performance.now() - t0).toBeLessThan(1_000);
  }, 10_000);

  test("audit M-9: imports are rate-limited per client address (IPv6 /64) and per wallet", async () => {
    let ip = "203.0.113.9";
    const limited = roundupRoutes({ chainId: CHAIN, db: t.db, ipOf: () => ip, importIpLimiter: new RateLimiter(3, 3_600_000), importUserLimiter: new RateLimiter(2, 3_600_000) });
    const content = "Date,Description,Amount\n2026-09-02,Cafe,-3.10\n";
    const send = async (who = alice) => post("/import", await signed("import", sha256Hex(content), { content }, who, nowS(), who.address), limited);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const userLimited = await send(); // third for alice: per-wallet limit (2)
    expect(userLimited.status).toBe(429);
    expect(((await userLimited.json()) as any).error.message).toContain("this wallet");
    const ipLimited = await send(mallory); // fourth from this address: per-IP limit (3)
    expect(ipLimited.status).toBe(429);
    expect(((await ipLimited.json()) as any).error.message).toContain("this address");
    // bad signatures cannot use up a wallet's quota: they never reach the per-wallet limiter
    ip = "2001:db8:aa:bb::1";
    const forged = await post("/import", await signed("import", sha256Hex(content), { content }, mallory, nowS(), alice.address), limited);
    expect(forged.status).toBe(401);
    ip = "2001:db8:aa:bb::2";
    expect((await send(mallory)).status).toBe(200);
    ip = "2001:db8:aa:bb:ffff::3"; // same /64: its third request
    expect((await send(bob)).status).toBe(200);
    ip = "2001:db8:aa:bb::4"; // a fourth address of that /64 shares its limit
    const v6 = await send(bob);
    expect(v6.status).toBe(429);
    expect(((await v6.json()) as any).error.message).toContain("this address");
  });

  test("oversized upload is refused", async () => {
    const content = "x".repeat(4_100_000);
    const r = await post("/v1/roundups/import", { content, user: alice.address, issuedAt: nowS(), signature: "0x" });
    expect(r.status).toBe(413);
  });
});

describe("Plaid link and unlink", () => {
  test("503 when Plaid is not configured", async () => {
    expect((await post("/plaid/link-token", await signed("plaid-link", "", {}), noPlaid)).status).toBe(503);
  });

  test("link-token: signed request; Plaid sees a hashed user id, never the wallet address", async () => {
    const r = await post("/v1/roundups/plaid/link-token", await signed("plaid-link", "", {}));
    expect(await r.json()).toEqual({ linkToken: "link-sandbox-abc", expiration: "2026-10-04T12:00:00Z" });
    const body = plaidCalls.find((c) => c.path === "link")!.body;
    expect(body.user.client_user_id).toBe(sha256Hex(`${CHAIN}:${alice.address.toLowerCase()}`));
    expect(JSON.stringify(body).toLowerCase()).not.toContain(alice.address.toLowerCase().slice(2));
    expect(body.products).toEqual(["transactions"]);
    expect((await post("/v1/roundups/plaid/link-token", await signed("plaid-link", "", {}, mallory))).status).toBe(401);
  });

  test("exchange: the access token is stored sealed (bound to chain, user, item), never in clear", async () => {
    const r = await post("/v1/roundups/plaid/exchange", await signed("plaid-exchange", sha256Hex("public-sandbox-1"), { publicToken: "public-sandbox-1" }));
    expect(await r.json()).toEqual({ itemId: "item-77", linked: true });
    const [row] = await t.sql`select status, secret_enc from roundup_sources where kind = 'plaid' and source_key = 'item-77'`;
    expect(row!.status).toBe("active");
    expect(String(row!.secret_enc)).not.toContain("access-sandbox-secret");
    const opened = new TextDecoder().decode(await sealer.open(row!.secret_enc, plaidAad(CHAIN, alice.address, "item-77")));
    expect(opened).toBe("access-sandbox-secret");
    await expect(sealer.open(row!.secret_enc, plaidAad(CHAIN, mallory.address, "item-77"))).rejects.toThrow();
    // the signature binds the public token
    expect((await post("/v1/roundups/plaid/exchange", await signed("plaid-exchange", sha256Hex("public-sandbox-2"), { publicToken: "public-sandbox-1" }))).status).toBe(401);
  });

  test("unlink: source inactive, sealed token forgotten, Plaid item removed; unknown source 404", async () => {
    const r = await post("/v1/roundups/sources/unlink", await signed("unlink", "plaid:item-77", { kind: "plaid", sourceKey: "item-77" }));
    expect(await r.json()).toEqual({ unlinked: true });
    const [row] = await t.sql`select status, secret_enc from roundup_sources where source_key = 'item-77'`;
    expect(row).toEqual({ status: "unlinked", secret_enc: null });
    expect(plaidCalls.find((c) => c.path === "remove")!.body.access_token).toBe("access-sandbox-secret");
    expect((await post("/v1/roundups/sources/unlink", await signed("unlink", "plaid:nope", { kind: "plaid", sourceKey: "nope" }))).status).toBe(404);
    expect((await post("/v1/roundups/sources/unlink", await signed("unlink", "bank:x", { kind: "bank", sourceKey: "x" }))).status).toBe(400);
  });
});

describe("roundupsFromEnv", () => {
  test("off unless ROUNDUPS_ENABLED=1; Plaid routes need KEEPER_SECRET_KEY to seal tokens", async () => {
    expect(await roundupsFromEnv({}, { chainId: CHAIN, db: t.db })).toBeUndefined();
    expect(await roundupsFromEnv({ ROUNDUPS_ENABLED: "1" }, { chainId: CHAIN, db: t.db })).toBeDefined();
    await expect(roundupsFromEnv({ ROUNDUPS_ENABLED: "1", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s" }, { chainId: CHAIN, db: t.db })).rejects.toThrow(/KEEPER_SECRET_KEY/);
  });
});
