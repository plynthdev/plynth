// Arcus (off-chain matching engine, Robinhood Chain settlement) behind PerpVenueClient, from its public docs
// (docs.arcus.xyz, api-reference). Market data, positions and account reads are public by address; orders are
// signed with a TRADE-ONLY Ed25519 API key (registered once by the venue wallet's EIP-712 signature: a human
// step, see the runbook).
//
// Order signing (Scheme 1): the signed bytes are the canonical, key-sorted JSON payload
//   {"ad":"0x…lower","ai":N,"ct":ns,"g":ns,"m":N,"op":1,"p":ticks,"q":quantums,"r":0|1,"s":0|1,"t":N,"v":1}
// headers X-API-Key (hex public key), X-Timestamp (ns, == ct), X-Signature (128 hex).
// goodTilTime must be >= 1 month ahead even for IOC. Funding is hourly, > 0 longs pay shorts.
// Perps are quoted in shares; positions convert to Stock Token units through the token's uiMultiplier.
import { getAddress, type Address } from "viem";
import { keyFromSeed, signBytes, type Ed25519Key } from "./ed25519";
import type { FundingQuote, MarketMap, OrderRequest, OrderResult, PerpVenueClient, VenueStatement } from "./types";
import { VenueError } from "./types";
import { floorTo, fromFixed, ratePerSecond, sharesToTokens, toFixed, tokensToShares } from "./units";

export const ARCUS_MAINNET = "https://api.arcus.xyz";
export const ARCUS_TESTNET = "https://api.testnet.arcus.xyz";
const GOOD_TIL_US = 40n * 24n * 3600n * 1_000_000n; // 40 days: the venue wants >= 1 month even for IOC

export type ArcusConfig = {
  baseUrl?: string | undefined;
  address: Address; // the venue wallet (master address) the treasury's Arcus account lives under
  accountIndex?: number;
  secret?: string | undefined; // ed25519 seed (hex); never logged
  markets: MarketMap[]; // symbol = Arcus market display name, e.g. "TSLA-USD"
  fetchImpl?: typeof fetch;
  nowNs?: () => bigint;
  retries?: number;
  backoffMs?: number;
};

type Json = Record<string, unknown>;
type MarketInfo = { id: number; tick: bigint; step: bigint; mark: bigint; fundingRate: string };

/** Canonical Scheme-1 payload text for a placeOrder (exported for tests). */
export function canonicalPlace(p: { ad: string; ai: number; c?: string; ct: bigint; g: bigint; m: number; p: bigint; q: bigint; r: 0 | 1; s: 0 | 1; t: number }): string {
  const o: Record<string, string | number | bigint> = { ad: p.ad.toLowerCase(), ai: p.ai };
  if (p.c) o.c = p.c;
  Object.assign(o, { ct: p.ct, g: p.g, m: p.m, op: 1, p: p.p, q: p.q, r: p.r, s: p.s, t: p.t, v: 1 });
  return `{${Object.keys(o)
    .sort()
    .map((k) => `"${k}":${typeof o[k] === "string" ? JSON.stringify(o[k]) : String(o[k])}`)
    .join(",")}}`;
}

export class ArcusClient implements PerpVenueClient {
  readonly kind = "arcus" as const;
  readonly name: string;
  private key?: Ed25519Key;

  constructor(readonly cfg: ArcusConfig) {
    this.name = `arcus:${cfg.address.toLowerCase()}:${cfg.accountIndex ?? 0}`;
    if (cfg.secret) this.key = keyFromSeed(cfg.secret);
  }

  get apiKey(): string | undefined {
    return this.key ? Buffer.from(this.key.publicRaw).toString("hex") : undefined;
  }

  private q(): string {
    return `address=${this.cfg.address}&accountIndex=${this.cfg.accountIndex ?? 0}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: Json, headers: Record<string, string> = {}): Promise<Json> {
    const f = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.baseUrl ?? ARCUS_MAINNET;
    const retries = this.cfg.retries ?? 3;
    let wait = this.cfg.backoffMs ?? 500;
    let last: VenueError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let status: number | null = null;
      try {
        const r = await f(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body ? JSON.stringify(body) : null,
          signal: AbortSignal.timeout(10_000),
        });
        status = r.status;
        const j = (await r.json().catch(() => ({}))) as Json;
        if (r.ok) return j;
        last = new VenueError(this.name, r.status, `${method} ${path.split("?")[0]} -> ${r.status} ${String(j.error ?? "")}`, j);
        if (r.status < 500 && r.status !== 429) throw last;
      } catch (e) {
        if (e instanceof VenueError && e.status !== null && e.status < 500 && e.status !== 429) throw e;
        last = e instanceof VenueError ? e : new VenueError(this.name, status, e instanceof Error ? e.message : String(e));
      }
      if (attempt < retries) {
        await Bun.sleep(wait);
        wait *= 2;
      }
    }
    throw last!;
  }

  async marketInfo(symbol: string): Promise<MarketInfo> {
    const j = await this.call("GET", `/v1/markets?market=${encodeURIComponent(symbol)}`);
    const m = ((j.markets as Json[]) ?? []).find((x) => x.marketDisplayName === symbol);
    if (!m) throw new VenueError(this.name, null, `unknown market ${symbol}`);
    return {
      id: Number(m.marketId),
      tick: toFixed(String(m.tickSize), 18),
      step: toFixed(String(m.stepSize), 18),
      mark: toFixed(String(m.markPrice), 18),
      fundingRate: String(m.fundingRate),
    };
  }

  async funding(): Promise<FundingQuote[]> {
    const out: FundingQuote[] = [];
    for (const m of this.cfg.markets) {
      const i = await this.marketInfo(m.symbol);
      out.push({ underlying: m.underlying, ratePerSecond: ratePerSecond(i.fundingRate, 3600) });
    }
    return out;
  }

  /** Positions from GET /v1/positions (keyed by market id), equity from GET /v1/account. */
  async statement(): Promise<VenueStatement> {
    const [pos, acct] = await Promise.all([this.call("GET", `/v1/positions?${this.q()}`), this.call("GET", `/v1/account?${this.q()}`)]);
    const byName = new Map(this.cfg.markets.map((m) => [m.symbol, m]));
    const positions = [];
    const unmapped: string[] = [];
    for (const p of Object.values((pos.positions as Record<string, Json>) ?? {})) {
      const size = toFixed(String(p.size), 18);
      if (size === 0n) continue;
      const m = byName.get(String(p.marketDisplayName));
      if (!m) {
        unmapped.push(String(p.marketDisplayName));
        continue;
      }
      const signed = p.side === "SHORT" ? -size : size;
      positions.push({ underlying: getAddress(m.underlying), tokens: sharesToTokens(signed, m.multiplier) });
    }
    const s: VenueStatement = { venue: this.name, ts: Date.now(), positions, equityUsd: toFixed(String(acct.equity ?? 0), 18) };
    if (unmapped.length) s.unmapped = unmapped;
    return s;
  }

  /** MARKET + IOC with a protective price at mark +- maxSlippageBps (the venue caps it at 10%). */
  async placeOrder(o: OrderRequest): Promise<OrderResult> {
    if (!this.key) throw new VenueError(this.name, null, "placeOrder without an API key");
    if (o.tokens <= 0n) throw new VenueError(this.name, null, "order size must be > 0");
    if (o.maxSlippageBps > 1000) throw new VenueError(this.name, null, "protective bound above the venue's 10% limit");
    const m = this.cfg.markets.find((x) => x.underlying.toLowerCase() === o.underlying.toLowerCase());
    if (!m) throw new VenueError(this.name, null, `no market for ${o.underlying}`);
    const i = await this.marketInfo(m.symbol);
    const size = floorTo(tokensToShares(o.tokens, m.multiplier), i.step);
    if (size === 0n) throw new VenueError(this.name, null, "order below the venue's step size");
    const bound = o.side === "buy" ? (i.mark * BigInt(10_000 + o.maxSlippageBps)) / 10_000n : (i.mark * BigInt(10_000 - o.maxSlippageBps)) / 10_000n;
    const price = floorTo(bound, i.tick);
    const ct = (this.cfg.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n))();
    const gUs = ct / 1000n + GOOD_TIL_US;
    const payload = canonicalPlace({
      ad: this.cfg.address,
      ai: this.cfg.accountIndex ?? 0,
      ct,
      g: gUs * 1000n,
      m: i.id,
      p: price / i.tick,
      q: size / i.step,
      r: o.reduceOnly ? 1 : 0,
      s: o.side === "buy" ? 0 : 1,
      t: 2, // IOC
    });
    const signature = Buffer.from(signBytes(this.key, payload)).toString("hex");
    const body = {
      address: this.cfg.address,
      marketId: i.id,
      accountIndex: this.cfg.accountIndex ?? 0,
      orderSide: o.side === "buy" ? "BUY" : "SELL",
      orderType: "MARKET",
      quantity: fromFixed(size, 18),
      price: fromFixed(price, 18),
      timeInForce: "IOC",
      goodTilTime: gUs.toString(),
      reduceOnly: o.reduceOnly,
    };
    const j = await this.call("POST", `/v1/placeOrder?address=${this.cfg.address}`, body, {
      "X-API-Key": this.apiKey!,
      "X-Timestamp": ct.toString(),
      "X-Signature": signature,
    });
    return { id: String(j.orderId), status: String(j.status ?? "accepted"), tokens: sharesToTokens(size, m.multiplier), side: o.side, underlying: m.underlying };
  }
}
