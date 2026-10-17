// Venue adapters (todo 29): Orderly against recorded public fixtures (api.orderly.org, 2026-10-04) and
// docs-shaped private fixtures through a mock fetch, its WS funding stream against a local WebSocket server,
// Arcus against a mock server built from its public API reference, exact unit conversions, and the ABI subsets
// against contracts/out.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, toFunctionSelector, type Abi, type AbiFunction, type Address } from "viem";
import {
  ArcusClient,
  OrderlyClient,
  OrderlyFundingStream,
  asVenueReader,
  base58Decode,
  base58Encode,
  basisSleeveAbi,
  canonicalPlace,
  fromFixed,
  inHouseVenueAbi,
  keyFromSeed,
  marketAbi,
  sharesToTokens,
  toFixed,
  tokensToShares,
  venueValuerAbi,
  verifyBytes,
  type MarketMap,
} from "./";

const FIX = join(import.meta.dir, "..", "..", "testing", "fixtures", "venues");
const fx = (p: string) => readFileSync(join(FIX, p), "utf8");
const E18 = 10n ** 18n;
const TSLA = getAddress("0x00000000000000000000000000000000000075a1");
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // test-key (RFC 8032 vector 1)
const RFC_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function mockFetch(routes: Record<string, string | ((c: Call) => Response)>, calls: Call[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const c: Call = { url: u, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") };
    calls.push(c);
    const path = new URL(u).pathname;
    const r = routes[`${c.method} ${path}`];
    if (!r) return new Response(JSON.stringify({ success: false, message: "no route" }), { status: 404 });
    return typeof r === "function" ? r(c) : new Response(r, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("units", () => {
  test("decimal <-> fixed is exact, including JSON numbers in exponent form", () => {
    expect(toFixed("371.61", 18)).toBe(37161n * 10n ** 16n);
    expect(toFixed(-12.5, 18)).toBe(-125n * 10n ** 17n);
    expect(toFixed(1e-7, 18)).toBe(10n ** 11n);
    expect(toFixed("0.00000505787037037", 18)).toBe(5057870370370n);
    expect(fromFixed(-125n * 10n ** 17n, 18)).toBe("-12.5");
    expect(() => toFixed("1,5", 18)).toThrow();
  });

  test("shares <-> tokens through uiMultiplier", () => {
    const mult = 10005n * 10n ** 14n; // 1.0005 shares per token
    const tokens = sharesToTokens(10_005n * 10n ** 15n, mult); // 10.005 shares
    expect(tokens).toBe(10n * E18);
    expect(tokensToShares(tokens, mult)).toBe(10_005n * 10n ** 15n);
  });
});

describe("ed25519", () => {
  test("seed -> public key matches RFC 8032 test vector 1; base58 round-trips", () => {
    const k = keyFromSeed(SEED);
    expect(Buffer.from(k.publicRaw).toString("hex")).toBe(RFC_PUB);
    expect(base58Decode(base58Encode(k.publicRaw))).toEqual(k.publicRaw);
    expect(keyFromSeed(`ed25519:${base58Encode(Buffer.from(SEED, "hex"))}`).publicRaw).toEqual(k.publicRaw);
  });
});

describe("Orderly adapter (recorded fixtures)", () => {
  const markets: MarketMap[] = [{ underlying: TSLA, symbol: "PERP_TSLA_USDC", multiplier: E18 }];
  const routes = {
    "GET /v1/public/info/PERP_TSLA_USDC": fx("orderly/public_info_PERP_TSLA_USDC.json"),
    "GET /v1/public/funding_rate/PERP_TSLA_USDC": fx("orderly/public_funding_rate_PERP_TSLA_USDC.json"),
    "GET /v1/public/futures/PERP_TSLA_USDC": fx("orderly/public_futures_PERP_TSLA_USDC.json"),
    "GET /v1/positions": fx("orderly/private_positions.json"),
    "POST /v1/order": fx("orderly/private_order.json"),
  };

  test("funding: est_funding_rate per 8h period -> signed rate per second", async () => {
    const calls: Call[] = [];
    const c = new OrderlyClient({ markets, fetchImpl: mockFetch(routes, calls) });
    const [f] = await c.funding();
    expect(f!.underlying).toBe(TSLA);
    expect(f!.ratePerSecond).toBe(toFixed("0.0001", 18) / 28_800n); // longs pay 0.01% per 8 hours
    expect(calls.every((x) => !("orderly-signature" in x.headers))).toBe(true); // public calls are unsigned
  });

  test("statement: shares -> Stock Token units, equity = total collateral value, unsigned calls refused", async () => {
    const calls: Call[] = [];
    const mult = 10005n * 10n ** 14n;
    const c = new OrderlyClient({ accountId: "0xabc", secret: SEED, markets: [{ ...markets[0]!, multiplier: mult }], fetchImpl: mockFetch(routes, calls), now: () => 1_791_116_000_000 });
    const s = await c.statement();
    expect(s.positions).toEqual([{ underlying: TSLA, tokens: sharesToTokens(-125n * 10n ** 17n, mult) }]);
    expect(s.equityUsd).toBe(toFixed("5627.38", 18));
    expect(s.unmapped).toBeUndefined(); // the zero NVDA row is ignored
    await expect(new OrderlyClient({ markets, fetchImpl: mockFetch(routes, []) }).statement()).rejects.toThrow("private call without accountId/secret");
  });

  test("private requests carry a valid ed25519 signature over ts+method+path+body", async () => {
    const calls: Call[] = [];
    const c = new OrderlyClient({ accountId: "0xabc", secret: SEED, markets, fetchImpl: mockFetch(routes, calls), now: () => 1_791_116_000_000 });
    expect(c.orderlyKey).toBe(`ed25519:${base58Encode(Buffer.from(RFC_PUB, "hex"))}`);
    const r = await c.placeOrder({ underlying: TSLA, side: "sell", tokens: 25n * 10n ** 17n, reduceOnly: false, maxSlippageBps: 50 });
    expect(r).toMatchObject({ id: "5512793", side: "sell", tokens: 25n * 10n ** 17n });
    const post = calls.find((x) => x.method === "POST")!;
    const body = JSON.parse(post.body);
    // IOC limit at mark 371.61 x (1 - 0.5%) floored to the 0.01 tick; 2.5 shares; not reduce-only.
    expect(body).toEqual({ symbol: "PERP_TSLA_USDC", order_type: "IOC", side: "SELL", order_price: 369.75, order_quantity: 2.5, reduce_only: false });
    const h = post.headers;
    expect(h["orderly-account-id"]).toBe("0xabc");
    expect(h["orderly-timestamp"]).toBe("1791116000000");
    const msg = `${h["orderly-timestamp"]}POST/v1/order${post.body}`;
    expect(verifyBytes(Buffer.from(RFC_PUB, "hex"), msg, Buffer.from(h["orderly-signature"]!, "base64url"))).toBe(true);
    expect(verifyBytes(Buffer.from(RFC_PUB, "hex"), `${msg} `, Buffer.from(h["orderly-signature"]!, "base64url"))).toBe(false);
  });

  test("4xx is final, 5xx retries with backoff", async () => {
    let n = 0;
    const flaky = mockFetch({ ...routes, "GET /v1/public/funding_rate/PERP_TSLA_USDC": () => (++n < 3 ? new Response("{}", { status: 503 }) : new Response(routes["GET /v1/public/funding_rate/PERP_TSLA_USDC"])) }, []);
    const c = new OrderlyClient({ markets, fetchImpl: flaky, backoffMs: 1 });
    expect((await c.funding()).length).toBe(1);
    expect(n).toBe(3);
    const calls: Call[] = [];
    const bad = new OrderlyClient({ markets, fetchImpl: mockFetch({ ...routes, "GET /v1/public/info/PERP_TSLA_USDC": () => new Response('{"success":false,"message":"bad symbol"}', { status: 400 }) }, calls), backoffMs: 1 });
    await expect(bad.funding()).rejects.toThrow("400");
    expect(calls.length).toBe(1);
  });

  test("no client has a withdraw method (trade-only keys; withdrawals are on-chain to the account)", () => {
    for (const proto of [OrderlyClient.prototype, ArcusClient.prototype]) {
      for (const k of Object.getOwnPropertyNames(proto)) expect(k.toLowerCase()).not.toContain("withdraw");
    }
  });

  test("as a VenueReader for the mirror pusher; unmapped venue positions refuse to post", async () => {
    const c = new OrderlyClient({ accountId: "0xabc", secret: SEED, markets, fetchImpl: mockFetch(routes, []) });
    const r = await asVenueReader(c, "0x0000000000000000000000000000000000000c05", async () => 7n, async () => 3n).read();
    expect(r.flowInSeen).toBe(7n);
    expect(r.flowOutSeen).toBe(3n); // review v2 I-6: passed through, never defaulted
    expect(r.positions[0]!.tokens).toBe(-125n * 10n ** 17n);
    expect(r.funding![0]!.ratePerSecond > 0n).toBe(true);
    const lonely = new OrderlyClient({ accountId: "0xabc", secret: SEED, markets: [{ underlying: TSLA, symbol: "PERP_NVDA_USDC", multiplier: E18 }], fetchImpl: mockFetch({ ...routes, "GET /v1/public/info/PERP_NVDA_USDC": routes["GET /v1/public/info/PERP_TSLA_USDC"], "GET /v1/public/funding_rate/PERP_NVDA_USDC": routes["GET /v1/public/funding_rate/PERP_TSLA_USDC"] }, []) });
    await expect(asVenueReader(lonely, "0x0000000000000000000000000000000000000c05", async () => 0n, async () => 0n).read()).rejects.toThrow("unmapped venue positions PERP_TSLA_USDC");
  });
});

describe("Orderly WS funding stream", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const got: string[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, msg) {
          got.push(String(msg));
          const j = JSON.parse(String(msg));
          if (j.event === "subscribe") {
            ws.send(JSON.stringify({ event: "ping", ts: 1 }));
            ws.send(JSON.stringify({ topic: "PERP_TSLA_USDC@estfundingrate", ts: 1791116000000, data: { symbol: "PERP_TSLA_USDC", fundingRate: -0.00002, fundingTs: 1791129600000 } }));
          }
        },
      },
    });
  });
  afterAll(() => server?.stop(true));

  test("subscribes, answers ping, and turns a negative estimate into a flip the desk can see", async () => {
    const seen: bigint[] = [];
    const s = new OrderlyFundingStream({ url: `ws://127.0.0.1:${server!.port}/ws/stream/0xabc`, markets: [{ underlying: TSLA, symbol: "PERP_TSLA_USDC", multiplier: E18 }], onFunding: (q) => seen.push(q.ratePerSecond) });
    await s.start();
    for (let i = 0; i < 50 && seen.length === 0; i++) await Bun.sleep(20);
    expect(JSON.parse(got[0]!)).toMatchObject({ event: "subscribe", topic: "PERP_TSLA_USDC@estfundingrate" });
    expect(got.some((m) => JSON.parse(m).event === "pong")).toBe(true);
    expect(seen[0]).toBe(-toFixed("0.00002", 18) / 28_800n);
    expect(s.latest.get("PERP_TSLA_USDC")!.ratePerSecond < 0n).toBe(true);
    s.stop();
  });
});

describe("Arcus adapter (mock server from the public API reference)", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const orders: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const ADDR = "0x000000000000000000000000000000000000A5c5" as Address;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/v1/markets") return new Response(fx("arcus/markets_TSLA-USD.json"));
        if (u.pathname === "/v1/positions") return new Response(fx("arcus/positions.json"));
        if (u.pathname === "/v1/account") return new Response(fx("arcus/account.json"));
        if (u.pathname === "/v1/placeOrder" && req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const headers = Object.fromEntries(req.headers.entries());
          orders.push({ headers, body });
          return new Response(JSON.stringify({ orderId: "a-1", status: "FILLED" }), { status: 200 });
        }
        return new Response('{"error":"no route"}', { status: 404 });
      },
    });
  });
  afterAll(() => server?.stop(true));

  const markets = (): MarketMap[] => [{ underlying: TSLA, symbol: "TSLA-USD", multiplier: E18 }];

  test("funding from the recorded market (hourly rate) and positions/equity by address", async () => {
    const c = new ArcusClient({ baseUrl: `http://127.0.0.1:${server!.port}`, address: ADDR, markets: markets() });
    const [f] = await c.funding();
    const live = JSON.parse(fx("arcus/markets_TSLA-USD.json")).markets[0].fundingRate as string;
    expect(f!.ratePerSecond).toBe(toFixed(live, 18) / 3600n);
    const s = await c.statement();
    expect(s.positions).toEqual([{ underlying: TSLA, tokens: -325n * 10n ** 16n }]);
    expect(s.equityUsd).toBe(toFixed("2400.3", 18));
  });

  test("placeOrder signs the canonical Scheme-1 payload; the server can verify it", async () => {
    const c = new ArcusClient({ baseUrl: `http://127.0.0.1:${server!.port}`, address: ADDR, secret: SEED, markets: markets(), nowNs: () => 1_791_116_000_000_000_000n });
    const r = await c.placeOrder({ underlying: TSLA, side: "buy", tokens: 1_234_567_890_123_456_789n, reduceOnly: true, maxSlippageBps: 100 });
    expect(r).toMatchObject({ id: "a-1", status: "FILLED", side: "buy" });
    const o = orders.at(-1)!;
    const mk = JSON.parse(fx("arcus/markets_TSLA-USD.json")).markets[0];
    const tick = toFixed(mk.tickSize, 18);
    const step = toFixed(mk.stepSize, 18);
    const price = ((toFixed(mk.markPrice, 18) * 10_100n) / 10_000n / tick) * tick;
    const qty = (1_234_567_890_123_456_789n / step) * step;
    expect(o.body).toMatchObject({ address: ADDR, marketId: 29, orderSide: "BUY", orderType: "MARKET", timeInForce: "IOC", reduceOnly: true, quantity: fromFixed(qty, 18), price: fromFixed(price, 18) });
    expect(BigInt(o.body.goodTilTime as string) * 1000n - 1_791_116_000_000_000_000n >= 30n * 86_400n * 10n ** 9n).toBe(true);
    const payload = canonicalPlace({ ad: ADDR, ai: 0, ct: 1_791_116_000_000_000_000n, g: BigInt(o.body.goodTilTime as string) * 1000n, m: 29, p: price / tick, q: qty / step, r: 1, s: 0, t: 2 });
    expect(payload.startsWith(`{"ad":"${ADDR.toLowerCase()}","ai":0,"ct":1791116000000000000,`)).toBe(true);
    expect(o.headers["x-api-key"]).toBe(RFC_PUB);
    expect(o.headers["x-timestamp"]).toBe("1791116000000000000");
    expect(verifyBytes(Buffer.from(RFC_PUB, "hex"), payload, Buffer.from(o.headers["x-signature"]!, "hex"))).toBe(true);
  });

  test("refuses a protective bound wider than the venue's 10% and orders without a key", async () => {
    const c = new ArcusClient({ baseUrl: `http://127.0.0.1:${server!.port}`, address: ADDR, secret: SEED, markets: markets() });
    await expect(c.placeOrder({ underlying: TSLA, side: "sell", tokens: E18, reduceOnly: false, maxSlippageBps: 1500 })).rejects.toThrow("10%");
    const ro = new ArcusClient({ baseUrl: `http://127.0.0.1:${server!.port}`, address: ADDR, markets: markets() });
    await expect(ro.placeOrder({ underlying: TSLA, side: "sell", tokens: E18, reduceOnly: false, maxSlippageBps: 50 })).rejects.toThrow("without an API key");
  });
});

describe("venue ABIs match contracts/out", () => {
  const OUT = join(import.meta.dir, "..", "..", "..", "..", "contracts", "out");
  const art = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).abi as Abi;
  const sels = (abi: Abi) => new Set(abi.filter((i) => i.type === "function").map((i) => toFunctionSelector(i as AbiFunction)));
  test("every selector exists", () => {
    if (!existsSync(join(OUT, "BasisSleeve.sol"))) {
      const forge = Bun.which("forge");
      if (forge) Bun.spawnSync([forge, "build", "--root", join(OUT, "..")], { stdout: "ignore", stderr: "ignore" });
    }
    if (!existsSync(join(OUT, "BasisSleeve.sol"))) return;
    const check = (mine: Abi, theirs: Abi) => {
      const all = sels(theirs);
      for (const i of mine) if (i.type === "function") expect(all.has(toFunctionSelector(i as AbiFunction)), (i as AbiFunction).name).toBe(true);
    };
    check(inHouseVenueAbi, art("InHousePerpVenue.sol", "InHousePerpVenue"));
    check(marketAbi, art("PerpMarket.sol", "PerpMarket"));
    check(basisSleeveAbi, art("BasisSleeve.sol", "BasisSleeve"));
    check(venueValuerAbi, art("Valuer.sol", "Valuer"));
  });
});
