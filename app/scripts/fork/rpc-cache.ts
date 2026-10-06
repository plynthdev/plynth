// A caching JSON-RPC proxy between anvil and the public mainnet RPC, so a fork can live longer than the public
// node keeps history.
//
// Why: anvil forks lazily. Every account or storage slot the fork touches for the first time is fetched from the
// upstream RPC *at the fork block*. Robinhood Chain's free public RPC is not an archive node: it serves state
// for roughly the last 10-15 minutes of blocks and then answers "historical state ... is not available". A fork
// that is used for hours (or restarted from its state file days later) then fails on the first new slot it reads.
//
// What it does: answers state reads (eth_getStorageAt, eth_getBalance, eth_getCode, eth_getTransactionCount,
// eth_getAccountInfo, eth_getProof) from a cache persisted in app/.fork/rpc-cache.jsonl. On a miss it asks
// upstream at the requested block; if upstream no longer has that block's state it asks for "latest" instead and
// records that it did (the value is then mainnet state from after the fork block: for slots nobody wrote since,
// such as a new address's balance, it is the same value). Every answer is pinned once cached, so the fork stays
// consistent across restarts. Everything else (blocks, logs, chain id) passes through.
//
//   bun scripts/fork/rpc-cache.ts            (up.sh runs it; FORK_RPC_CACHE_PORT, default 8600)
//
// Read-only: it forwards only read methods upstream and refuses anything that would send a transaction.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_DIR } from "./lib";

export const STATE_METHODS = new Set(["eth_getStorageAt", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getAccountInfo", "eth_getAccount", "eth_getProof"]);
const WRITE_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction", "personal_sign"]);

type RpcReq = { jsonrpc: "2.0"; id: unknown; method: string; params?: unknown[] };
type RpcRes = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** Cache key of a state read: method + every param, including the block it was asked at (the fork block). */
export function cacheKey(method: string, params: unknown[] = []): string {
  return `${method}:${JSON.stringify(params).toLowerCase()}`;
}

/** True when upstream refused because it no longer keeps that block's state. */
export function isPrunedError(e: { message?: string } | undefined): boolean {
  const m = (e?.message ?? "").toLowerCase();
  return m.includes("historical state") || m.includes("missing trie node") || m.includes("state is not available") || m.includes("header not found") || m.includes("pruned");
}

export class RpcCache {
  private map = new Map<string, unknown>();
  stats = { hits: 0, misses: 0, latestFallbacks: 0 };

  constructor(
    readonly upstream: string,
    readonly file?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const { k, v } = JSON.parse(line);
          this.map.set(k, v);
        } catch {}
      }
    }
  }

  get size() {
    return this.map.size;
  }

  private async up(req: RpcReq): Promise<RpcRes> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.fetcher(this.upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(20_000) });
        if (r.status === 429 || r.status >= 500) throw new Error(`upstream HTTP ${r.status}`);
        return (await r.json()) as RpcRes;
      } catch (e) {
        if (attempt >= 5) return { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: `upstream unreachable: ${(e as Error).message}` } };
        await Bun.sleep(500 * 2 ** attempt);
      }
    }
  }

  async handle(req: RpcReq): Promise<RpcRes> {
    if (WRITE_METHODS.has(req.method)) return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `${req.method} is not forwarded (read-only proxy)` } };
    if (!STATE_METHODS.has(req.method)) return this.up(req);
    const key = cacheKey(req.method, req.params);
    if (this.map.has(key)) {
      this.stats.hits++;
      return { jsonrpc: "2.0", id: req.id, result: this.map.get(key) };
    }
    this.stats.misses++;
    let res = await this.up(req);
    if (res.error && isPrunedError(res.error)) {
      const params = [...(req.params ?? [])];
      params[params.length - 1] = "latest";
      res = await this.up({ ...req, params });
      if (!res.error) this.stats.latestFallbacks++;
    }
    if (!res.error) {
      this.map.set(key, res.result);
      if (this.file) appendFileSync(this.file, `${JSON.stringify({ k: key, v: res.result })}\n`);
    }
    return { ...res, id: req.id };
  }

  async handleBody(body: unknown): Promise<unknown> {
    if (Array.isArray(body)) return Promise.all(body.map((b) => this.handle(b as RpcReq)));
    return this.handle(body as RpcReq);
  }
}

if (import.meta.main) {
  const upstream = process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const port = Number(process.env.FORK_RPC_CACHE_PORT || 8600);
  const cache = new RpcCache(upstream, join(FORK_DIR, "rpc-cache.jsonl"));
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, pid: process.pid, cached: cache.size, ...cache.stats });
      if (req.method !== "POST") return new Response("POST JSON-RPC", { status: 405 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      return Response.json(await cache.handleBody(body));
    },
  });
  console.log(`[rpc-cache] :${server.port} -> ${new URL(upstream).host} (${cache.size} cached entries)`);
  setInterval(() => console.log(`[rpc-cache] ${JSON.stringify({ cached: cache.size, ...cache.stats })}`), 60_000);
}
