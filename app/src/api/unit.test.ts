// Fast tests: no chain, no database.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address } from "viem";
import { vaultAbi, crowdAbi } from "@/abi/api";
import {
  BLOCKED_COUNTRIES,
  BlockTimes,
  buildClaimOpen,
  buildDeposit,
  buildSetHiddenKeys,
  buildSetMix,
  buildSetSettings,
  buildWithdraw,
  corsOrigins,
  createApp,
  DEFAULT_CORS_ORIGINS,
  eligibility,
  fixed,
  parseAmount,
  parseCursor,
  TxInputError,
  type ApiDeployment,
  type Deps,
} from "./";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const dep: ApiDeployment = { vault: A(1), crowd: A(2), beacon: A(3), valuer: A(4), usdg: A(5), stocks: [{ symbol: "mTSLA", token: A(0x10) }, { symbol: "mNVDA", token: A(0x11) }], deployBlock: 0n };
const noChain = new Proxy({}, { get: () => () => Promise.reject(new Error("no chain in unit tests")) }) as any;
const deps: Deps = { chainId: 31337, pub: noChain, db: noChain, dep, blockTimes: new BlockTimes(noChain) };
const app = createApp(deps);

describe("format", () => {
  test("fixed truncates toward zero with exact places", () => {
    expect(fixed(1_234_567n, 6)).toBe("1.234567");
    expect(fixed(5n, 6)).toBe("0.000005");
    expect(fixed(0n, 6)).toBe("0.000000");
    expect(fixed(1_999_999_999_999_999_999n, 18)).toBe("1.999999");
    expect(fixed(-15n, 1)).toBe("-1.500000");
    expect(fixed(12n, 0, 0)).toBe("12");
  });

  test("parseAmount rejects signs, exponents, empty and too many decimals", () => {
    expect(parseAmount("12.5")).toBe(12_500_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    for (const bad of ["-1", "1e6", "", ".5", "1.", "1.0000001", "0x10", "1,5"]) expect(() => parseAmount(bad)).toThrow();
  });

  test("fuzz: parseAmount(fixed(x)) == x for random 6-decimal amounts", () => {
    for (let i = 0; i < 2000; i++) {
      const x = BigInt(Math.floor(Math.random() * 2 ** 53)) * BigInt(1 + Math.floor(Math.random() * 1000));
      expect(parseAmount(fixed(x, 6))).toBe(x);
    }
  });

  test("parseCursor accepts only <block>-<logIndex>", () => {
    expect(parseCursor("12-3")).toEqual({ block: 12n, logIndex: 3 });
    expect(parseCursor(undefined)).toBeUndefined();
    expect(() => parseCursor("12;drop")).toThrow();
  });
});

describe("meta.eligibility (stub, not KYC)", () => {
  const e = (h: Record<string, string>) => eligibility(new Headers(h));
  test("blocks US, GB, CA, CH by IP country even with a clean attestation", () => {
    for (const c of BLOCKED_COUNTRIES) expect(e({ "cf-ipcountry": c, "x-plynth-residency": "DE" })).toMatchObject({ allowed: false, reason: "ip_country_restricted" });
  });
  test("blocks a self-attested residency in a restricted country (UK alias included)", () => {
    for (const c of [...BLOCKED_COUNTRIES, "UK", "ca"]) expect(e({ "x-plynth-residency": c })).toMatchObject({ allowed: false, reason: "residency_restricted" });
  });
  test("requires a self-attestation", () => {
    expect(e({})).toMatchObject({ allowed: false, reason: "self_attestation_required" });
    expect(e({ "x-plynth-residency": "nonsense" })).toMatchObject({ allowed: false, reason: "self_attestation_required" });
  });
  test("allows an attested non-restricted residency, and says it is not KYC", () => {
    const r = e({ "x-plynth-residency": "de", "cf-ipcountry": "FR" });
    expect(r).toMatchObject({ allowed: true, reason: "ok", residency: "DE", ipCountry: "FR", kyc: false });
    expect(r.note).toContain("not KYC");
  });
});

describe("tx builders validate like the contracts", () => {
  const ok = { roundTo: 1, multiplier: 1, weeklyCap: "500", fixedTopUp: "0", mode: "open" as const };
  test("setSettings rules: roundTo 1/5/10, multiplier 1-3, cap <= 500, top-up 0/25/50/100", () => {
    expect(() => buildSetSettings(1, dep, ok)).not.toThrow();
    for (const bad of [{ roundTo: 2 }, { multiplier: 0 }, { multiplier: 4 }, { weeklyCap: "500.000001" }, { fixedTopUp: "30" }, { mode: "loud" as any }]) {
      expect(() => buildSetSettings(1, dep, { ...ok, ...bad })).toThrow(TxInputError);
    }
    const d = decodeFunctionData({ abi: vaultAbi, data: buildSetSettings(1, dep, { ...ok, mode: "hidden", fixedTopUp: "100" }).data });
    expect(d.args[0]).toMatchObject({ mode: 2, fixedTopUp: 100_000_000n });
  });
  test("deposit/withdraw: amount > 0, to != zero", () => {
    expect(() => buildDeposit(1, dep, "0")).toThrow(TxInputError);
    expect(() => buildWithdraw(1, dep, "1", A(0))).toThrow(TxInputError);
    expect(decodeFunctionData({ abi: vaultAbi, data: buildDeposit(1, dep, "0.5").data }).args).toEqual([500_000n]);
  });
  test("setMix: 1-5 known tokens, no duplicates, weights sum to 10000", () => {
    expect(() => buildSetMix(1, dep, [])).toThrow(TxInputError);
    expect(() => buildSetMix(1, dep, [{ token: A(0x99), weightBps: 10_000 }])).toThrow(/unknown/);
    expect(() => buildSetMix(1, dep, [{ token: A(0x10), weightBps: 5000 }, { token: A(0x10), weightBps: 5000 }])).toThrow(/duplicate/);
    expect(() => buildSetMix(1, dep, [{ token: A(0x10), weightBps: 9999 }])).toThrow(/sum/);
    expect(() => buildSetMix(1, dep, [{ token: A(0x10), weightBps: 0 }, { token: A(0x11), weightBps: 10_000 }])).toThrow(TxInputError);
  });
  test("setHiddenKeys (audit M-6): low-order viewing keys and out-of-field / zero ownerPk are refused, on REST too", async () => {
    const good = { ownerPk: `0x${"00".repeat(31)}07`, viewingPub: `0x${"09".padEnd(64, "0")}` } as const;
    const d = decodeFunctionData({ abi: vaultAbi, data: buildSetHiddenKeys(1, dep, good.ownerPk, good.viewingPub).data });
    expect(d.functionName).toBe("setHiddenKeys");
    // libsodium's low-order blocklist (canonical and non-canonical encodings)
    const lowOrder = [
      `0x${"00".repeat(32)}`,
      `0x01${"00".repeat(31)}`,
      "0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", // not-a-key
      "0x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", // not-a-key
      `0xec${"ff".repeat(30)}7f`,
      `0xed${"ff".repeat(30)}7f`,
      `0xee${"ff".repeat(30)}7f`,
    ] as const;
    for (const v of lowOrder) expect(() => buildSetHiddenKeys(1, dep, good.ownerPk, v)).toThrow(/low-order/);
    expect(() => buildSetHiddenKeys(1, dep, `0x${"ff".repeat(32)}`, good.viewingPub)).toThrow(/field/);
    expect(() => buildSetHiddenKeys(1, dep, `0x${"00".repeat(32)}`, good.viewingPub)).toThrow(TxInputError);
    const r = await app.request("/v1/tx/setHiddenKeys", { method: "POST", body: JSON.stringify({ ownerPk: good.ownerPk, viewingPub: lowOrder[2] }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toMatch(/low-order/);
    expect((await app.request("/v1/tx/setHiddenKeys", { method: "POST", body: JSON.stringify(good) })).status).toBe(200);
  });
  test("claimOpen: known asset, integer bookId", () => {
    expect(() => buildClaimOpen(1, dep, A(0x99), "0")).toThrow(TxInputError);
    expect(() => buildClaimOpen(1, dep, A(0x10), "-1")).toThrow(TxInputError);
    expect(decodeFunctionData({ abi: crowdAbi, data: buildClaimOpen(1, dep, A(0x10), "7").data }).args).toEqual([A(0x10), 7n]);
  });
});

describe("HTTP layer", () => {
  test("CORS_ORIGINS parsing; defaults include the Lovable app and the local dev server", () => {
    expect(DEFAULT_CORS_ORIGINS).toContain("https://plynthlations.lovable.app");
    expect(DEFAULT_CORS_ORIGINS).toContain("http://localhost:5173");
    expect(corsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
    expect(corsOrigins(" https://a.example/, https://b.example ")).toEqual(["https://a.example", "https://b.example"]);
  });

  test("CORS: allowed origin preflight passes; unknown origin preflight and request are refused", async () => {
    const pre = await app.request("/v1/tx/deposit", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const badPre = await app.request("/v1/tx/deposit", { method: "OPTIONS", headers: { origin: "https://plynthlations.lovable.app.evil.example", "access-control-request-method": "POST" } });
    expect(badPre.status).toBe(403);
    expect(badPre.headers.get("access-control-allow-origin")).toBeNull();
    const bad = await app.request("/v1/meta/eligibility", { headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    const custom = createApp(deps, { corsOrigins: ["https://only.example"] });
    expect((await custom.request("/v1/meta/eligibility", { headers: { origin: "http://localhost:5173" } })).status).toBe(403);
    expect((await custom.request("/v1/meta/eligibility", { headers: { origin: "https://only.example" } })).headers.get("access-control-allow-origin")).toBe("https://only.example");
  });

  test("REST mirror == tRPC for chain-free procedures; bad input is 400 on both", async () => {
    const t = (await (await app.request("/trpc/tx.deposit", { method: "POST", body: JSON.stringify({ amount: "3" }), headers: { "content-type": "application/json" } })).json()) as any;
    const r = (await (await app.request("/v1/tx/deposit", { method: "POST", body: JSON.stringify({ amount: "3" }) })).json()) as any;
    expect(r).toEqual(t.result.data);
    expect(r).toEqual({ to: dep.vault, data: buildDeposit(31337, dep, "3").data, value: "0", chainId: 31337 });

    for (const [path, body] of [["deposit", { amount: "-1" }], ["setMix", { mix: [{ token: A(0x10), weightBps: 1 }] }], ["withdraw", { amount: "1", to: "nope" }]] as const) {
      expect((await app.request(`/v1/tx/${path}`, { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
      expect((await app.request(`/trpc/tx.${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).status).toBe(400);
    }
    expect((await app.request("/v1/tx/deposit", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await app.request("/v1/account/0x123/overview")).status).toBe(400);
    expect((await app.request("/v1/nope")).status).toBe(404);
  });

  test("health is 503 on REST when chain and db are down, and never leaks internals on 500", async () => {
    const r = await app.request("/v1/meta/health");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).ok).toBe(false);
    const o = await app.request(`/v1/account/${A(7)}/overview`);
    expect(o.status).toBe(500);
    expect(await o.json()).toEqual({ error: { code: "INTERNAL_SERVER_ERROR", message: "internal error" } });
    const t = await app.request(`/trpc/account.overview?input=${encodeURIComponent(JSON.stringify({ address: A(7) }))}`);
    expect(t.status).toBe(500);
    const txt = await t.text();
    expect(txt).toContain("internal error");
    expect(txt).not.toContain("no chain in unit tests");
    expect(txt).not.toContain("stack");
  });
});

describe("eligibility routes (todo 22) mounted in the API", () => {
  test("served at /eligibility/check and /v1/eligibility/check behind the CORS allow-list; absent when not configured", async () => {
    const { Hono } = await import("hono");
    const { EligibilityService, MemoryDecisionStore, eligibilityRoutes } = await import("@/eligibility");
    const { privateKeyToAccount } = await import("viem/accounts");
    const attester = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key
    const vendor = { name: "stub", run: async () => ({ ok: true as const, flag: 1 }) };
    const svc = new EligibilityService({ chainId: 31337, registry: A(0xe1), attester, screens: [vendor], store: new MemoryDecisionStore() });
    const routes: InstanceType<typeof Hono> = eligibilityRoutes(svc, { clientIp: () => "203.0.113.1" });
    const app = createApp(deps, { eligibility: routes });
    const body = JSON.stringify({ address: A(0x77), attestationSig: "0x00", expiry: "1" });
    for (const path of ["/eligibility/check", "/v1/eligibility/check"]) {
      const r = await app.request(path, { method: "POST", body, headers: { origin: "http://localhost:5173", "content-type": "application/json" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(((await r.json()) as any).attestation.registry).toBe(A(0xe1));
    }
    expect((await app.request("/v1/eligibility/check", { method: "POST", body, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await createApp(deps).request("/v1/eligibility/check", { method: "POST", body })).status).toBe(404);
  });
});
