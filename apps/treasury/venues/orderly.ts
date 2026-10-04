// Orderly Network (off-chain order book; Robinhood Chain vault in USDG) behind PerpVenueClient.
//
// REST: public market data needs no key. Private calls are signed with a TRADE-ONLY Orderly key (ed25519):
//   message   = `${timestampMs}${METHOD}${pathWithQuery}${body}`
//   headers   = orderly-timestamp, orderly-account-id, orderly-key ("ed25519:<base58 pubkey>"),
//               orderly-signature (base64url of the ed25519 signature)
// Registering an Orderly account and adding a key needs a wallet signature (EIP-712) from the treasury's venue
// wallet; that is a human step (see the runbook), so this client takes the account id and key as config.
// Orderly lists no 46630 deployment, so tests use recorded fixtures for public calls and docs-shaped fixtures
// for private ones, served by a mock fetch.
//
// WS: OrderlyFundingStream subscribes to `<symbol>@estfundingrate` on the public stream and keeps the latest
// estimated funding rate per market, so the basis desk sees a flip without polling.
//
// Orderly perps are quoted in shares of the underlying; positions convert to Stock Token units through the
// token's uiMultiplier. Funding is per 8-hour period (`funding_period`), > 0 longs pay shorts.
import { getAddress, type Address } from "viem";
import { keyFromSeed, signBytes, base58Encode, type Ed25519Key } from "./ed25519";
import type { FundingQuote, MarketMap, OrderRequest, OrderResult, PerpVenueClient, VenueStatement } from "./types";
import { VenueError } from "./types";
import { floorTo, fromFixed, ratePerSecond, sharesToTokens, toFixed, tokensToShares } from "./units";

export const ORDERLY_MAINNET = "https://api.orderly.org";
export const ORDERLY_TESTNET = "https://testnet-api.orderly.org";
export const ORDERLY_WS_MAINNET = "wss://ws-evm.orderly.org/ws/stream";
export const ORDERLY_WS_TESTNET = "wss://testnet-ws-evm.orderly.org/ws/stream";

export type OrderlyConfig = {
  baseUrl?: string;
  accountId?: string; // Orderly account id (0x… hex); required for private calls
  secret?: string; // ed25519 seed (hex or base58, optionally "ed25519:"); never logged
  markets: MarketMap[];
  fetchImpl?: typeof fetch;
  now?: () => number; // unix ms
  retries?: number;
  backoffMs?: number;
};

type Json = Record<string, unknown>;

export class OrderlyClient implements PerpVenueClient {
  readonly kind = "orderly" as const;
  readonly name: string;
  private key?: Ed25519Key;
  private info = new Map<string, { baseTick: bigint; quoteTick: bigint; fundingPeriodSec: number }>();

  constructor(readonly cfg: OrderlyConfig) {
    this.name = `orderly:${cfg.accountId ?? "public"}`;
    if (cfg.secret) this.key = keyFromSeed(cfg.secret);
  }

  /** "ed25519:<base58>" public key the venue knows this client by. */
  get orderlyKey(): string | undefined {
    return this.key ? `ed25519:${base58Encode(this.key.publicRaw)}` : undefined;
  }

  private market(u: Address): MarketMap {
    const m = this.cfg.markets.find((x) => x.underlying.toLowerCase() === u.toLowerCase());
    if (!m) throw new VenueError(this.name, null, `no market for ${u}`);
    return m;
  }

  private bySymbol(symbol: string): MarketMap | undefined {
    return this.cfg.markets.find((x) => x.symbol === symbol);
  }

  /** Signature headers for a private request (exported for tests). */
  signHeaders(method: string, pathWithQuery: string, body: string, ts: number): Record<string, string> {
    if (!this.key || !this.cfg.accountId) throw new VenueError(this.name, null, "private call without accountId/secret");
    const sig = Buffer.from(signBytes(this.key, `${ts}${method}${pathWithQuery}${body}`)).toString("base64url");
    return {
      "orderly-timestamp": String(ts),
      "orderly-account-id": this.cfg.accountId,
      "orderly-key": this.orderlyKey!,
      "orderly-signature": sig,
    };
  }

  private async call(method: "GET" | "POST", path: string, body?: Json, signed = false): Promise<Json> {
    const f = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.baseUrl ?? ORDERLY_MAINNET;
    const text = body ? JSON.stringify(body) : "";
    const retries = this.cfg.retries ?? 3;
    let wait = this.cfg.backoffMs ?? 500;
    let last: VenueError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const headers: Record<string, string> = {
        "content-type": method === "POST" ? "application/json" : "application/x-www-form-urlencoded",
      };
      if (signed) Object.assign(headers, this.signHeaders(method, path, text, (this.cfg.now ?? Date.now)()));
      let status: number | null = null;
      try {
        const r = await f(`${base}${path}`, { method, headers, body: text || undefined, signal: AbortSignal.timeout(10_000) });
        status = r.status;
        const j = (await r.json().catch(() => ({}))) as Json;
        if (r.ok && j.success !== false) return j;
        last = new VenueError(this.name, r.status, `${method} ${path} -> ${r.status} ${String(j.message ?? "")}`, j);
        if (r.status < 500 && r.status !== 429) throw last; // final
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

  private async symbolInfo(symbol: string) {
    let i = this.info.get(symbol);
    if (!i) {
      const j = (await this.call("GET", `/v1/public/info/${symbol}`)).data as Json;
      i = {
        baseTick: toFixed(String(j.base_tick), 18),
        quoteTick: toFixed(String(j.quote_tick), 18),
        fundingPeriodSec: Number(j.funding_period ?? 8) * 3600,
      };
      this.info.set(symbol, i);
    }
    return i;
  }

  /** Estimated next funding per market (public). */
  async funding(): Promise<FundingQuote[]> {
    const out: FundingQuote[] = [];
    for (const m of this.cfg.markets) {
      const { fundingPeriodSec } = await this.symbolInfo(m.symbol);
      const d = (await this.call("GET", `/v1/public/funding_rate/${m.symbol}`)).data as Json;
      out.push({ underlying: m.underlying, ratePerSecond: ratePerSecond(String(d.est_funding_rate), fundingPeriodSec) });
    }
    return out;
  }

  async markPrice(symbol: string): Promise<bigint> {
    const d = (await this.call("GET", `/v1/public/futures/${symbol}`)).data as Json;
    return toFixed(String(d.mark_price), 18);
  }

  /** Positions (in Stock Token units) and equity = total collateral value (holding + unsettled PnL). */
  async statement(): Promise<VenueStatement> {
    const j = await this.call("GET", "/v1/positions", undefined, true);
    const d = j.data as Json;
    const positions = [];
    const unmapped: string[] = [];
    for (const r of (d.rows as Json[]) ?? []) {
      const qty = toFixed(String(r.position_qty), 18);
      if (qty === 0n) continue;
      const m = this.bySymbol(String(r.symbol));
      if (!m) unmapped.push(String(r.symbol));
      else positions.push({ underlying: getAddress(m.underlying), tokens: sharesToTokens(qty, m.multiplier) });
    }
    const s: VenueStatement = {
      venue: this.name,
      ts: Number(j.timestamp ?? (this.cfg.now ?? Date.now)()),
      positions,
      equityUsd: toFixed(String(d.total_collateral_value ?? 0), 18),
    };
    if (unmapped.length) s.unmapped = unmapped;
    return s;
  }

  /** IOC limit at mark +- maxSlippageBps (Orderly MARKET orders carry no price bound). */
  async placeOrder(o: OrderRequest): Promise<OrderResult> {
    if (o.tokens <= 0n) throw new VenueError(this.name, null, "order size must be > 0");
    const m = this.market(o.underlying);
    const { baseTick, quoteTick } = await this.symbolInfo(m.symbol);
    const qty = floorTo(tokensToShares(o.tokens, m.multiplier), baseTick);
    if (qty === 0n) throw new VenueError(this.name, null, "order below the venue's base tick");
    const mark = await this.markPrice(m.symbol);
    const bound = o.side === "buy" ? (mark * BigInt(10_000 + o.maxSlippageBps)) / 10_000n : (mark * BigInt(10_000 - o.maxSlippageBps)) / 10_000n;
    const price = floorTo(bound, quoteTick);
    const body = {
      symbol: m.symbol,
      order_type: "IOC",
      side: o.side === "buy" ? "BUY" : "SELL",
      order_price: Number(fromFixed(price, 18)),
      order_quantity: Number(fromFixed(qty, 18)),
      reduce_only: o.reduceOnly,
    };
    const j = await this.call("POST", "/v1/order", body, true);
    const d = j.data as Json;
    return { id: String(d.order_id), status: "accepted", tokens: sharesToTokens(qty, m.multiplier), side: o.side, underlying: m.underlying };
  }
}

// ---------------------------------------------------------------- WebSocket funding stream

type WsLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: { data?: unknown }) => void): void;
};

export type FundingStreamOptions = {
  url: string; // `${ORDERLY_WS_MAINNET}/<accountId or any id>`
  markets: MarketMap[];
  fundingPeriodSec?: number; // 8h
  wsImpl?: new (url: string) => WsLike;
  onFunding?: (q: FundingQuote & { symbol: string; ts: number }) => void;
};

/** Public `<symbol>@estfundingrate` stream. Answers server pings; `latest` holds the last rate per market. */
export class OrderlyFundingStream {
  readonly latest = new Map<string, FundingQuote & { symbol: string; ts: number }>();
  private ws?: WsLike;

  constructor(readonly opts: FundingStreamOptions) {}

  start(): Promise<void> {
    const Ws = this.opts.wsImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const ws = new Ws(this.opts.url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        for (const m of this.opts.markets) ws.send(JSON.stringify({ id: `f-${m.symbol}`, event: "subscribe", topic: `${m.symbol}@estfundingrate` }));
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("orderly ws error")));
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    });
  }

  onMessage(raw: string) {
    let j: Json;
    try {
      j = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (j.event === "ping") {
      this.ws?.send(JSON.stringify({ event: "pong", ts: Date.now() }));
      return;
    }
    const topic = String(j.topic ?? "");
    if (!topic.endsWith("@estfundingrate")) return;
    const d = j.data as Json;
    const symbol = String(d.symbol ?? topic.split("@")[0]);
    const m = this.opts.markets.find((x) => x.symbol === symbol);
    if (!m) return;
    const q = { symbol, underlying: m.underlying, ratePerSecond: ratePerSecond(String(d.fundingRate), this.opts.fundingPeriodSec ?? 8 * 3600), ts: Number(j.ts ?? Date.now()) };
    this.latest.set(symbol, q);
    this.opts.onFunding?.(q);
  }

  stop() {
    this.ws?.close();
  }
}
