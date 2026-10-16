import { describe, expect, test } from "bun:test";
import { signClaim } from "@plynth/sdk/stealth";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseClaim, relayerApp, type ClaimArgs, type RelayerDeps } from "./app";
import { RateLimiter } from "./ratelimit";

const CHAIN = 31337;
const SC = "0x00000000000000000000000000000000000005c0" as Address;
const VAULT = "0x0000000000000000000000000000000000000a11" as Address;
const TOKEN = "0x00000000000000000000000000000000000070c1" as Address;
const DEST = "0x000000000000000000000000000000000000de57" as Address;
const STEALTH_KEY = "0x00000000000000000000000000000000000000000000000000000000000057e1" as Hex; // test-key
const OTHER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000b0b" as Hex; // test-key
const STEALTH = privateKeyToAccount(STEALTH_KEY).address;
const NOW = 1_800_000_000;

function setup(over: Partial<RelayerDeps> = {}) {
  const sent: ClaimArgs[] = [];
  const nonces = new Map<string, bigint>();
  const deps: RelayerDeps = {
    chainId: CHAIN,
    stealthClaims: SC,
    plynth: [VAULT],
    relayer: "0x0000000000000000000000000000000000000001",
    nonceOf: async (s) => nonces.get(s.toLowerCase()) ?? 0n,
    balanceOf: async () => 1_000n,
    simulate: async () => ({ ok: true }),
    send: async (a) => {
      sent.push(a);
      nonces.set(a.stealth.toLowerCase(), (nonces.get(a.stealth.toLowerCase()) ?? 0n) + 1n);
      return `0x${"ab".repeat(32)}` as Hex;
    },
    now: () => NOW,
    ipOf: (c) => c.req.header("x-test-ip") ?? "1.1.1.1",
    ...over,
  };
  const app = relayerApp(deps);
  const post = (body: unknown, ip = "1.1.1.1") =>
    app.request("/claim", { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, post, sent, nonces };
}

async function body(key: Hex, o: { to?: Address; raw?: bigint; nonce?: bigint; deadline?: bigint } = {}) {
  const { message, sig } = await signClaim(key, CHAIN, SC, { token: TOKEN, to: o.to ?? DEST, raw: o.raw ?? 100n, nonce: o.nonce ?? 0n, deadline: o.deadline ?? BigInt(NOW + 600) });
  return { token: message.token, stealth: message.stealth, to: message.to, raw: message.raw.toString(), deadline: message.deadline.toString(), sig };
}

describe("POST /claim", () => {
  test("valid claim: verified off-chain, simulated, sent; returns the tx hash", async () => {
    const t = setup();
    const r = await t.post(await body(STEALTH_KEY));
    expect(r.status).toBe(200);
    expect((await r.json()).txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ token: TOKEN, stealth: STEALTH, to: DEST, raw: 100n });
  });

  test("replay of a used signature is rejected (nonce moved on)", async () => {
    const t = setup();
    const b = await body(STEALTH_KEY);
    expect((await t.post(b)).status).toBe(200);
    expect((await t.post(b)).status).toBe(401);
    expect(t.sent).toHaveLength(1);
  });

  test("wrong signer, or a field changed after signing, is rejected", async () => {
    const t = setup();
    const forged = { ...(await body(OTHER_KEY)), stealth: STEALTH };
    expect((await t.post(forged)).status).toBe(401);
    const redirected = { ...(await body(STEALTH_KEY)), to: "0x000000000000000000000000000000000000bad0" };
    expect((await t.post(redirected)).status).toBe(401);
    const more = { ...(await body(STEALTH_KEY)), raw: "101" };
    expect((await t.post(more)).status).toBe(401);
    expect(t.sent).toHaveLength(0);
  });

  test("expired deadline is rejected before any chain call", async () => {
    let calls = 0;
    const t = setup({ nonceOf: async () => (calls++, 0n) });
    const r = await t.post(await body(STEALTH_KEY, { deadline: BigInt(NOW - 1) }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("expired");
    expect(calls).toBe(0);
  });

  test("destination that is a Plynth contract (incl. StealthClaims itself) is rejected", async () => {
    const t = setup();
    for (const to of [VAULT, SC]) {
      const r = await t.post(await body(STEALTH_KEY, { to }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/Plynth contract/);
    }
    expect(t.sent).toHaveLength(0);
  });

  test("malformed bodies are 400", async () => {
    const t = setup();
    const good = await body(STEALTH_KEY);
    for (const bad of ["not json", { ...good, token: "0x12" }, { ...good, raw: "0" }, { ...good, raw: "-1" }, { ...good, deadline: "soon" }, { ...good, sig: "0x1234" }, null]) {
      expect((await t.post(bad as any)).status).toBe(400);
    }
  });

  test("insufficient balance and simulation reverts are reported, nothing is sent", async () => {
    const poor = setup({ balanceOf: async () => 99n });
    expect((await poor.post(await body(STEALTH_KEY))).status).toBe(400);
    const rev = setup({ simulate: async () => ({ ok: false, error: "InsufficientBalance" }) });
    const r = await rev.post(await body(STEALTH_KEY));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/InsufficientBalance/);
    expect(poor.sent.length + rev.sent.length).toBe(0);
  });

  test("send failure is a 502 and frees the nonce for a retry", async () => {
    let fail = true;
    const t2 = setup({
      send: async () => {
        if (fail) throw new Error("rpc down");
        return `0x${"cd".repeat(32)}` as Hex;
      },
    });
    const b = await body(STEALTH_KEY);
    expect((await t2.post(b)).status).toBe(502);
    fail = false;
    expect((await t2.post(b)).status).toBe(200);
  });

  test("rate limit per IP", async () => {
    const t = setup({ ipLimiter: new RateLimiter(2, 60_000, () => 0) });
    const b = await body(STEALTH_KEY, { deadline: BigInt(NOW - 1) }); // cheap 400s still count
    expect((await t.post(b, "9.9.9.9")).status).toBe(400);
    expect((await t.post(b, "9.9.9.9")).status).toBe(400);
    expect((await t.post(b, "9.9.9.9")).status).toBe(429);
    expect((await t.post(b, "8.8.8.8")).status).toBe(400);
  });

  test("rate limit per stealth address, counted only for correctly signed requests", async () => {
    const t = setup({ stealthLimiter: new RateLimiter(1, 60_000, () => 0), ipLimiter: new RateLimiter(100, 60_000) });
    // a stranger's forged requests for this stealth do not use up its quota
    for (let i = 0; i < 3; i++) expect((await t.post({ ...(await body(OTHER_KEY)), stealth: STEALTH }, `7.7.7.${i}`)).status).toBe(401);
    expect((await t.post(await body(STEALTH_KEY), "1.0.0.1")).status).toBe(200);
    const r = await t.post(await body(STEALTH_KEY, { nonce: 1n }), "1.0.0.2");
    expect(r.status).toBe(429);
  });

  test("concurrent requests for the same nonce: one is sent, the other gets 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      simulate: async () => {
        await gate;
        return { ok: true };
      },
    });
    const b = await body(STEALTH_KEY);
    const first = t.post(b, "1.0.0.1");
    await Bun.sleep(20);
    const second = await t.post(b, "1.0.0.2");
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("parseClaim and health", () => {
  test("accepts decimal or hex uints and normalises addresses", async () => {
    const b = await body(STEALTH_KEY);
    const p = parseClaim({ ...b, raw: "0x64", to: DEST.toLowerCase() });
    expect(typeof p).toBe("object");
    expect((p as ClaimArgs).raw).toBe(100n);
    expect(parseClaim({ ...b, raw: `0x1${"0".repeat(64)}` })).toMatch(/raw/);
  });

  test("GET /health", async () => {
    const r = await setup().app.request("/health");
    expect(await r.json()).toMatchObject({ ok: true, chainId: CHAIN, stealthClaims: SC });
  });
});

describe("CORS", () => {
  const WEB = "https://plynthnetwork.com";
  test("allowed origin gets CORS headers, preflight answers", async () => {
    const { app } = setup({ corsOrigins: [WEB] });
    const r = await app.request("/health", { headers: { origin: WEB } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(WEB);
    const pre = await app.request("/claim", { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBe(WEB);
  });
  test("unknown origin is refused; no Origin header passes", async () => {
    const { app } = setup({ corsOrigins: [WEB] });
    expect((await app.request("/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await app.request("/health")).status).toBe(200);
  });
  test("without corsOrigins there are no CORS headers (old behaviour)", async () => {
    const r = await setup().app.request("/health", { headers: { origin: WEB } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

