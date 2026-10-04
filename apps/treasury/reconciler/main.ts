// bun apps/treasury/reconciler/main.ts           -> reconciles every TREASURY_RECONCILE_INTERVAL_S (default 3600)
// bun apps/treasury/reconciler/main.ts --once    -> one pass, then exit
//
// Env: TREASURY_RPC_URL, DATABASE_URL (exceptions, venue_fills), TREASURY_RECONCILE_CONFIG (JSON file below),
// TREASURY_WEBHOOK_URLS (comma separated) + TREASURY_WEBHOOK_SECRET, ORDERLY_SECRET / ARCUS_SECRET (trade-only
// venue keys; never logged).
// Config: { "account": "0x…", "mirror": "0x…", "venues": [
//   { "kind": "inhouse", "venue": "0x…", "valuer": "0x…", "usdg": "0x…" },
//   { "kind": "orderly", "adapter": "0x…", "accountId": "0x…", "baseUrl": "…", "markets": [{ "underlying", "symbol", "multiplier" }] },
//   { "kind": "arcus", "adapter": "0x…", "address": "0x…", "accountIndex": 0, "markets": [...] } ] }
import { connect, databaseUrl } from "@plynth/db";
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { Webhooks } from "../risk/webhooks";
import { ArcusClient } from "../venues/arcus";
import { InHouseClient } from "../venues/inhouse";
import { OrderlyClient } from "../venues/orderly";
import type { MarketMap } from "../venues/types";
import { Reconciler, type VenueSource } from "./reconcile";
import { PgExceptionStore, PgLedger } from "./store";

type RawMarket = { underlying: string; symbol: string; multiplier: string };
const markets = (ms: RawMarket[]): MarketMap[] => ms.map((m) => ({ underlying: getAddress(m.underlying), symbol: m.symbol, multiplier: BigInt(m.multiplier) }));

const rpcUrl = process.env.TREASURY_RPC_URL;
const cfgPath = process.env.TREASURY_RECONCILE_CONFIG;
if (!rpcUrl || !cfgPath) throw new Error("TREASURY_RPC_URL and TREASURY_RECONCILE_CONFIG are required");
const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as { account: string; mirror?: string; venues: Record<string, unknown>[] };
const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }) as PublicClient;
const chainId = await pub.getChainId();

const venues: VenueSource[] = raw.venues.map((v) => {
  if (v.kind === "inhouse") {
    return { mode: "onchain", client: new InHouseClient(pub, { venue: getAddress(v.venue as string), valuer: getAddress(v.valuer as string), usdg: getAddress(v.usdg as string) }) };
  }
  if (v.kind === "orderly") {
    const client = new OrderlyClient({ baseUrl: v.baseUrl as string | undefined, accountId: v.accountId as string, secret: process.env.ORDERLY_SECRET, markets: markets(v.markets as RawMarket[]) });
    return { mode: "mirrored", adapter: getAddress(v.adapter as string), client };
  }
  if (v.kind === "arcus") {
    const client = new ArcusClient({ baseUrl: v.baseUrl as string | undefined, address: getAddress(v.address as string), accountIndex: Number(v.accountIndex ?? 0), markets: markets(v.markets as RawMarket[]) });
    return { mode: "mirrored", adapter: getAddress(v.adapter as string), client };
  }
  throw new Error(`unknown venue kind ${String(v.kind)}`);
});

const { db, close } = connect(databaseUrl());
const urls = (process.env.TREASURY_WEBHOOK_URLS ?? "").split(",").filter(Boolean);
const webhooks = urls.length ? new Webhooks({ urls, secret: process.env.TREASURY_WEBHOOK_SECRET }) : undefined;
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
  const interval = Number(process.env.TREASURY_RECONCILE_INTERVAL_S || 3600) * 1000;
  for (;;) {
    try {
      await pass();
    } catch (e) {
      say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(interval);
  }
}
