// bun run treasury-reconciler           -> reconciles every TREASURY_RECONCILE_INTERVAL_S (default 3600);
//                                         GET /health on TREASURY_RECONCILER_PORT (default 8798)
// bun run treasury-reconciler --once    -> one pass, then exit
//
// Env (config.ts): TREASURY_RPC_URL, DATABASE_URL (exceptions, venue_fills), TREASURY_RECONCILE_CONFIG (JSON file below),
// TREASURY_WEBHOOK_URLS (comma separated) + TREASURY_WEBHOOK_SECRET, ORDERLY_SECRET / ARCUS_SECRET (trade-only
// venue keys; never logged).
// Config: { "account": "0x…", "mirror": "0x…", "venues": [
//   { "kind": "inhouse", "venue": "0x…", "valuer": "0x…", "usdg": "0x…" },
//   { "kind": "orderly", "adapter": "0x…", "accountId": "0x…", "baseUrl": "…", "markets": [{ "underlying", "symbol", "multiplier" }] },
//   { "kind": "arcus", "adapter": "0x…", "address": "0x…", "accountIndex": 0, "markets": [...] } ] }
import { keysFor, loadConfig, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { serveHealth } from "@/lib/health";
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { Webhooks } from "@/treasury/risk/webhooks";
import { ArcusClient } from "@/treasury/venues/arcus";
import { InHouseClient } from "@/treasury/venues/inhouse";
import { OrderlyClient } from "@/treasury/venues/orderly";
import type { MarketMap } from "@/treasury/venues/types";
import { Reconciler, type VenueSource } from "@/treasury/reconciler/reconcile";
import { PgExceptionStore, PgLedger } from "@/treasury/reconciler/store";

type RawMarket = { underlying: string; symbol: string; multiplier: string };
const markets = (ms: RawMarket[]): MarketMap[] => ms.map((m) => ({ underlying: getAddress(m.underlying), symbol: m.symbol, multiplier: BigInt(m.multiplier) }));

const config = loadConfig();
const rpcUrl = config.TREASURY_RPC_URL;
const cfgPath = config.TREASURY_RECONCILE_CONFIG;
if (!rpcUrl || !cfgPath) throw new Error("TREASURY_RPC_URL and TREASURY_RECONCILE_CONFIG are required");
const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as { account: string; mirror?: string; venues: Record<string, unknown>[] };
const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }) as PublicClient;
const chainId = await pub.getChainId();

const venues: VenueSource[] = raw.venues.map((v) => {
  if (v.kind === "inhouse") {
    return { mode: "onchain", client: new InHouseClient(pub, { venue: getAddress(v.venue as string), valuer: getAddress(v.valuer as string), usdg: getAddress(v.usdg as string) }) };
  }
  if (v.kind === "orderly") {
    const client = new OrderlyClient({ baseUrl: v.baseUrl as string | undefined, accountId: v.accountId as string, secret: config.ORDERLY_SECRET, markets: markets(v.markets as RawMarket[]) });
    return { mode: "mirrored", adapter: getAddress(v.adapter as string), client };
  }
  if (v.kind === "arcus") {
    const client = new ArcusClient({ baseUrl: v.baseUrl as string | undefined, address: getAddress(v.address as string), accountIndex: Number(v.accountIndex ?? 0), markets: markets(v.markets as RawMarket[]) });
    return { mode: "mirrored", adapter: getAddress(v.adapter as string), client };
  }
  throw new Error(`unknown venue kind ${String(v.kind)}`);
});

const { db, close } = connect(databaseUrl());
const urls = [...config.TREASURY_WEBHOOK_URLS];
const webhooks = urls.length ? new Webhooks({ urls, secret: config.TREASURY_WEBHOOK_SECRET }) : undefined;
const say = (m: string, extra?: unknown) => console.log(`[reconcile ${chainId}] ${m}${extra ? ` ${JSON.stringify(extra, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}` : ""}`);
const rec = new Reconciler(pub, { chainId, account: getAddress(raw.account) as Address, mirror: raw.mirror ? getAddress(raw.mirror) : undefined, venues }, { store: new PgExceptionStore(db), ledger: new PgLedger(db), webhooks, log: say });

async function pass() {
  const r = await rec.run();
  say(`pass done: ${r.breaks.length} break(s), ${r.newBreaks.length} new, ${r.resolved.length} resolved`);
  return r;
}

if (process.argv.includes("--once")) {
  try {
    const r = await pass();
    process.exitCode = r.breaks.length ? 2 : 0;
  } finally {
    await close();
  }
} else {
  const interval = config.TREASURY_RECONCILE_INTERVAL_S * 1000;
  let breaks: number | undefined;
  const health = serveHealth("treasury-reconciler", config.TREASURY_RECONCILER_PORT, () => ({ chainId, breaks }));
  say(`every ${interval / 1000} s, /health on :${health.port} ${JSON.stringify(safeConfigSummary(config, keysFor("TREASURY_", "ORDERLY_", "LOG_")))}`);
  for (;;) {
    try {
      breaks = (await pass()).breaks.length;
    } catch (e) {
      say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(interval);
  }
}
