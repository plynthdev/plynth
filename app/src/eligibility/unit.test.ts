import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ATTESTATION_TTL_S,
  attestationTypes,
  BLOCKED_COUNTRIES,
  checkIpCountry,
  checkSanctions,
  checkSelfAttestation,
  CLOCK_SKEW_S,
  eligibilityRoutes,
  EligibilityService,
  extractSdnAddresses,
  FLAG_IP_COUNTRY,
  FLAG_SANCTIONS,
  FLAG_SELF_ATTESTED,
  ipCountryScreen,
  MAX_LIST_AGE_MS,
  MemoryDecisionStore,
  MmdbCountry,
  normCountry,
  RateLimiter,
  registryDomain,
  SanctionsList,
  sanctionsScreen,
  selfAttestationScreen,
  selfAttestationTypedData,
  type Screen,
} from "./";
import { buildCountryMmdb } from "@/testing/mmdb-writer";

const FIX = join(import.meta.dir, "..", "testing", "fixtures", "eligibility");
const SDN = readFileSync(join(FIX, "sdn-sample.csv"), "utf8");
const SDN_COMMENTS = readFileSync(join(FIX, "sdn-comments-sample.csv"), "utf8");
const CHAIN = 31337;
const NOW = 1_800_000_000;
const user = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // test-key
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // test-key
const attester = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key
const REGISTRY = "0x00000000000000000000000000000000000e1191" as Address;
const SANCTIONED = "0x1111111111111111111111111111111111111111" as Address;

// 203.0.113.0/24 and 198.51.100.0/24 are documentation ranges: the countries are fixture data.
const MMDB = buildCountryMmdb({
  "203.0.113.0/24": "DE",
  "198.51.100.0/25": "US",
  "198.51.100.128/25": "GB",
  "192.0.2.0/24": "CA",
  "100.64.0.0/16": "CH",
  "100.65.0.0/16": "FR",
});
const geo = new MmdbCountry(MMDB);

async function selfSig(acct = user, expiry = BigInt(NOW + 3600), wallet: Address = acct.address): Promise<Hex> {
  return acct.signTypedData(selfAttestationTypedData(CHAIN, wallet, expiry));
}

function freshList(now = () => NOW * 1000) {
  const l = new SanctionsList({ now });
  l.load(extractSdnAddresses(SDN + SDN_COMMENTS), now());
  return l;
}

describe("countries", () => {
  test("normalises codes; UK -> GB; Tor/unknown are not countries", () => {
    expect(normCountry(" de ")).toBe("DE");
    expect(normCountry("uk")).toBe("GB");
    expect(normCountry("T1")).toBeNull();
    expect(normCountry("XX")).toBeNull();
    expect(normCountry("USA")).toBeNull();
    expect([...BLOCKED_COUNTRIES]).toEqual(["US", "GB", "CA", "CH"]);
  });
});

describe("source 1: self-attestation (EIP-712)", () => {
  test("a wallet's own signature passes", async () => {
    const sig = await selfSig();
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: BigInt(NOW + 3600), signature: sig, nowS: NOW })).toEqual({ ok: true });
  });
  test("someone else's signature, a tampered expiry or another chain fails", async () => {
    const bySomeoneElse = await other.signTypedData(selfAttestationTypedData(CHAIN, user.address, BigInt(NOW + 3600)));
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: BigInt(NOW + 3600), signature: bySomeoneElse, nowS: NOW })).toMatchObject({ ok: false, reason: "self_attestation_invalid" });
    const sig = await selfSig();
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: BigInt(NOW + 3601), signature: sig, nowS: NOW })).toMatchObject({ ok: false });
    expect(await checkSelfAttestation({ chainId: 4663, wallet: user.address, expiry: BigInt(NOW + 3600), signature: sig, nowS: NOW })).toMatchObject({ ok: false });
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: BigInt(NOW + 3600), signature: "0x1234", nowS: NOW })).toMatchObject({ ok: false, reason: "self_attestation_invalid" });
  });
  test("expired statements and expiries more than a year out are refused", async () => {
    const e = BigInt(NOW);
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: e, signature: await selfSig(user, e), nowS: NOW })).toMatchObject({ ok: false, reason: "self_attestation_expired" });
    const far = BigInt(NOW + 366 * 24 * 3600);
    expect(await checkSelfAttestation({ chainId: CHAIN, wallet: user.address, expiry: far, signature: await selfSig(user, far), nowS: NOW })).toMatchObject({ ok: false, reason: "self_attestation_invalid" });
  });
});

describe("source 2: IP country (MMDB + CF-IPCountry)", () => {
  test("reads the MMDB fixture like the db-ip lite file (IPv4 inside an IPv6 tree)", () => {
    expect(geo.databaseType).toBe("DBIP-Country-Lite");
    expect(geo.country("203.0.113.7")).toBe("DE");
    expect(geo.country("198.51.100.1")).toBe("US");
    expect(geo.country("198.51.100.200")).toBe("GB");
    expect(geo.country("192.0.2.9")).toBe("CA");
    expect(geo.country("100.64.3.3")).toBe("CH");
    expect(geo.country("10.0.0.1")).toBeNull();
    expect(geo.country("not an ip")).toBeNull();
  });
  test("US (and GB, CA, CH) IPs are refused", () => {
    for (const ip of ["198.51.100.1", "198.51.100.200", "192.0.2.9", "100.64.3.3"]) {
      expect(checkIpCountry({ ip, cfCountry: null, lookup: geo })).toMatchObject({ ok: false, reason: "ip_country_restricted" });
    }
    expect(checkIpCountry({ ip: "198.51.100.1", cfCountry: null, lookup: geo }).country).toBe("US");
  });
  test("a restricted CF-IPCountry refuses even if the database says otherwise, and vice versa", () => {
    expect(checkIpCountry({ ip: "203.0.113.7", cfCountry: "US", lookup: geo })).toMatchObject({ ok: false, reason: "ip_country_restricted", country: "US" });
    expect(checkIpCountry({ ip: "198.51.100.1", cfCountry: "DE", lookup: geo })).toMatchObject({ ok: false, reason: "ip_country_restricted", country: "US" });
    expect(checkIpCountry({ ip: null, cfCountry: "fr", lookup: null })).toEqual({ ok: true, country: "FR" });
  });
  test("unknown country (private IP, Tor, no database) fails closed unless allowUnknown", () => {
    expect(checkIpCountry({ ip: "10.0.0.1", cfCountry: null, lookup: geo })).toMatchObject({ ok: false, reason: "ip_country_unknown" });
    expect(checkIpCountry({ ip: "203.0.113.7", cfCountry: "T1", lookup: null })).toMatchObject({ ok: false, reason: "ip_country_unknown" });
    expect(checkIpCountry({ ip: "10.0.0.1", cfCountry: null, lookup: geo, allowUnknown: true })).toEqual({ ok: true, country: null });
    expect(checkIpCountry({ ip: "198.51.100.1", cfCountry: null, lookup: geo, allowUnknown: true })).toMatchObject({ ok: false });
  });
});

describe("source 3: sanctions (OFAC SDN + optional oracle)", () => {
  test("extracts only EVM digital-currency addresses from SDN text", () => {
    const s = extractSdnAddresses(SDN + SDN_COMMENTS);
    expect([...s].sort()).toEqual(
      [SANCTIONED, "0x2222222222222222222222222222222222222222", "0xabcdef0123456789abcdef0123456789abcdef01", "0x3333333333333333333333333333333333333333"].sort(),
    );
  });
  test("a sanctioned address is refused, any case", async () => {
    const list = freshList();
    expect(await checkSanctions({ address: SANCTIONED, list })).toEqual({ ok: false, reason: "sanctioned" });
    expect(await checkSanctions({ address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" as Address, list })).toMatchObject({ ok: false, reason: "sanctioned" });
    expect(await checkSanctions({ address: user.address, list })).toEqual({ ok: true });
  });
  test("a missing or stale list fails closed", async () => {
    let t = NOW * 1000;
    const list = new SanctionsList({ now: () => t });
    expect(await checkSanctions({ address: user.address, list })).toEqual({ ok: false, reason: "sanctions_list_unavailable" });
    list.load([SANCTIONED]);
    expect(await checkSanctions({ address: user.address, list })).toEqual({ ok: true });
    t += MAX_LIST_AGE_MS + 1;
    expect(await checkSanctions({ address: user.address, list })).toEqual({ ok: false, reason: "sanctions_list_unavailable" });
  });
  test("daily refresh downloads both files, caches to disk; a failed or empty download keeps the old list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-sanctions-"));
    try {
      const pages: Record<string, string> = { a: SDN, b: SDN_COMMENTS };
      const list = new SanctionsList({ urls: ["a", "b"], fetcher: async (u) => pages[u]!, cachePath: join(dir, "l.json"), now: () => NOW * 1000 });
      expect(await list.refresh()).toBe(4);
      pages.a = "no addresses here";
      pages.b = "";
      await expect(list.refresh()).rejects.toThrow("empty");
      expect(list.has(SANCTIONED)).toBe(true);
      const failing = new SanctionsList({ urls: ["x"], fetcher: async () => Promise.reject(new Error("HTTP 503")) });
      await expect(failing.refresh()).rejects.toThrow("503");
      const restarted = new SanctionsList({ cachePath: join(dir, "l.json"), now: () => NOW * 1000 });
      expect(restarted.loadCache()).toBe(true);
      expect(restarted.has(SANCTIONED)).toBe(true);
      expect(restarted.fresh()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("optional on-chain oracle: a hit refuses; an unreadable oracle fails closed", async () => {
    const list = freshList();
    const oracle = (r: (a: any) => Promise<unknown>) => ({ pub: { readContract: r } as any, address: REGISTRY });
    expect(await checkSanctions({ address: user.address, list, oracle: oracle(async (a) => a.args[0] === user.address) })).toEqual({ ok: false, reason: "sanctioned" });
    expect(await checkSanctions({ address: user.address, list, oracle: oracle(async () => false) })).toEqual({ ok: true });
    expect(await checkSanctions({ address: user.address, list, oracle: oracle(async () => Promise.reject(new Error("rpc"))) })).toEqual({ ok: false, reason: "sanctions_list_unavailable" });
  });
});

function service(store = new MemoryDecisionStore(), screens?: Screen[]) {
  return new EligibilityService({
    chainId: CHAIN,
    registry: REGISTRY,
    attester,
    screens: screens ?? [selfAttestationScreen(CHAIN), sanctionsScreen(freshList()), ipCountryScreen(geo)],
    store,
    nowS: () => NOW,
  });
}

describe("service", () => {
  test("all three pass -> a 30-day registry attestation signed by the attester, all flags set", async () => {
    const store = new MemoryDecisionStore();
    const d = await service(store).check({ address: user.address, attestationSig: await selfSig(), statementExpiry: BigInt(NOW + 3600), ip: "203.0.113.7", cfCountry: null });
    expect(d.allowed).toBe(true);
    if (!d.allowed) throw new Error();
    const a = d.attestation;
    expect(a.flags).toBe(FLAG_SELF_ATTESTED | FLAG_SANCTIONS | FLAG_IP_COUNTRY);
    expect(a.issuedAt).toBe(NOW - CLOCK_SKEW_S);
    expect(a.expiry - a.issuedAt).toBe(ATTESTATION_TTL_S);
    const ok = await verifyTypedData({
      address: attester.address,
      domain: registryDomain(CHAIN, REGISTRY),
      types: attestationTypes,
      primaryType: "Attestation",
      message: { user: user.address, issuedAt: BigInt(a.issuedAt), expiry: BigInt(a.expiry), flags: a.flags },
      signature: a.signature,
    });
    expect(ok).toBe(true);
    expect(store.rows).toEqual([{ chainId: CHAIN, address: user.address, allowed: true, reason: "ok", country: "DE", flags: 7, expiry: a.expiry, at: NOW }]);
  });
  test("refusals: sanctioned address, US IP, bad statement; decisions never hold the IP", async () => {
    const store = new MemoryDecisionStore();
    const s = service(store);
    const sanctionedSig = await selfSig(user, BigInt(NOW + 3600)); // wrong signer for SANCTIONED -> statement fails first
    expect(await s.check({ address: user.address, attestationSig: await selfSig(), statementExpiry: BigInt(NOW + 3600), ip: "198.51.100.1", cfCountry: null })).toMatchObject({ allowed: false, reason: "ip_country_restricted", country: "US" });
    expect(await s.check({ address: SANCTIONED, attestationSig: sanctionedSig, statementExpiry: BigInt(NOW + 3600), ip: "203.0.113.7", cfCountry: null })).toMatchObject({ allowed: false, reason: "self_attestation_invalid" });
    const noStatement = service(store, [sanctionsScreen(freshList()), ipCountryScreen(geo)]);
    expect(await noStatement.check({ address: SANCTIONED, attestationSig: "0x00", statementExpiry: 0n, ip: "203.0.113.7", cfCountry: null })).toMatchObject({ allowed: false, reason: "sanctioned" });
    expect(store.rows.map((r) => r.reason)).toEqual(["ip_country_restricted", "self_attestation_invalid", "sanctioned"]);
    for (const r of store.rows) {
      expect(JSON.stringify(r)).not.toContain("198.51.100");
      expect(JSON.stringify(r)).not.toContain("203.0.113");
      expect(r.expiry).toBeNull();
    }
  });
  test("pluggable: a vendor screen runs in line and can refuse", async () => {
    const vendor: Screen = { name: "vendor", run: async (r) => (r.address === user.address ? { ok: false, reason: "vendor_refused" } : { ok: true, flag: 8 }) };
    const s = service(new MemoryDecisionStore(), [vendor]);
    expect(await s.check({ address: user.address, attestationSig: "0x00", statementExpiry: 0n, ip: null, cfCountry: null })).toMatchObject({ allowed: false, reason: "vendor_refused" });
    const d = await s.check({ address: other.address, attestationSig: "0x00", statementExpiry: 0n, ip: null, cfCountry: null });
    expect(d).toMatchObject({ allowed: true, flags: 8 });
  });
});

describe("HTTP route", () => {
  const mk = (opts: Parameters<typeof eligibilityRoutes>[1] = {}) => {
    const app = new Hono();
    app.route("/eligibility", eligibilityRoutes(service(), { clientIp: () => "203.0.113.7", ...opts }));
    return app;
  };
  const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
    app.request("/eligibility/check", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  test("pass returns the attestation; refusal returns a reason", async () => {
    const app = mk();
    const r = await post(app, { address: user.address, attestationSig: await selfSig(), expiry: String(NOW + 3600) });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.allowed).toBe(true);
    expect(j.attestation).toMatchObject({ user: user.address, registry: REGISTRY, chainId: CHAIN, flags: 7 });
    const us = mk({ clientIp: () => "198.51.100.1" });
    expect(await (await post(us, { address: user.address, attestationSig: await selfSig(), expiry: NOW + 3600 })).json()).toEqual({ allowed: false, reason: "ip_country_restricted" });
  });
  test("bad input is 400", async () => {
    const app = mk();
    expect((await post(app, "nope")).status).toBe(400);
    expect((await post(app, { address: "0x12", attestationSig: "0x00", expiry: 1 })).status).toBe(400);
    expect((await post(app, { address: user.address, attestationSig: "zz", expiry: 1 })).status).toBe(400);
    expect((await post(app, { address: user.address, attestationSig: "0x00", expiry: "-1" })).status).toBe(400);
  });
  test("rate-limited per IP and per address (429)", async () => {
    const app = mk({ perIp: new RateLimiter(2, 60_000), perAddress: new RateLimiter(100, 60_000) });
    const body = { address: user.address, attestationSig: await selfSig(), expiry: NOW + 3600 };
    expect((await post(app, body)).status).toBe(200);
    expect((await post(app, body)).status).toBe(200);
    expect((await post(app, body)).status).toBe(429);
    const byAddr = mk({ perIp: new RateLimiter(100, 60_000), perAddress: new RateLimiter(1, 60_000) });
    expect((await post(byAddr, body)).status).toBe(200);
    expect((await post(byAddr, { ...body, address: user.address.toLowerCase() })).status).toBe(429);
    expect((await post(byAddr, { ...body, address: other.address })).status).toBe(200);
  });
  test("CF-IPCountry and forwarded IPs count only when the proxy is trusted", async () => {
    const body = { address: user.address, attestationSig: await selfSig(), expiry: NOW + 3600 };
    const untrusted = mk();
    expect(((await (await post(untrusted, body, { "cf-ipcountry": "US" })).json()) as any).allowed).toBe(true);
    const trusted = mk({ trustProxy: true, clientIp: undefined });
    expect(await (await post(trusted, body, { "cf-ipcountry": "US", "cf-connecting-ip": "203.0.113.7" })).json()).toEqual({ allowed: false, reason: "ip_country_restricted" });
    expect(await (await post(trusted, body, { "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).json()).toEqual({ allowed: false, reason: "ip_country_restricted" });
    expect(((await (await post(trusted, body, { "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "DE" })).json()) as any).allowed).toBe(true);
  });
});
