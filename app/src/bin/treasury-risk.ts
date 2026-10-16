// bun run treasury-risk   -> runs the risk service in a loop, GET /health on TREASURY_RISK_PORT (default 8795)
//
// Env (config.ts):
//   TREASURY_RPC_URL                 RPC (anvil / fork / testnet)
//   TREASURY_ACCOUNT                 the TreasuryAccount address
//   TREASURY_POSITION_MIRROR         PositionMirror address (optional; needed to push snapshots)
//   TREASURY_CONTROLLER_KEY | _KEYSTORE + _PASSWORD(_FILE)   the policy controller (signs mirror snapshots)
//   RISK_STATIC_READERS              optional JSON file: [{ venue, positions:[{underlying,tokens}], equityUsd, flowInSeen }]
//   RISK_WEBHOOK_URLS                comma-separated URLs for drawdown.state / risk.alert
//   RISK_WEBHOOK_SECRET              HMAC secret for x-plinth-signature
//   DATABASE_URL                     optional: also deliver drawdown.state/risk.alert to treasury_webhooks subscribers
//   RISK_INTERVAL_SEC                tick interval (default 30)
//   RISK_HYSTERESIS_BPS              drawdown hysteresis (default 50)
//   RISK_ONCE=1                      one tick, print the report, exit
import { isSet, keysFor, loadConfig, safeConfigSummary, type Config } from "@/config";
import { serveHealth } from "@/lib/health";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, type Address, type PublicClient } from "viem";
import { loadDeskAccount } from "@/treasury/desks/keys";
import { MirrorPusher, StaticVenueReader, type VenueReader } from "@/treasury/risk/mirror";
import { RiskService } from "@/treasury/risk/service";
import { connect } from "@/db";
import { WebhookDispatcher } from "@/treasury/webhooks/dispatcher";
import { fanout, stringify, Webhooks } from "@/treasury/risk/webhooks";

function need<K extends "TREASURY_RPC_URL" | "TREASURY_ACCOUNT">(config: Config, name: K): string {
  const v = config[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function staticReaders(path: string | undefined): VenueReader[] {
  if (!path) return [];
  const rows = JSON.parse(readFileSync(path, "utf8")) as { venue: string; positions: { underlying: string; tokens: string }[]; equityUsd: string; flowInSeen: string }[];
  return rows.map(
    (r) =>
      new StaticVenueReader(getAddress(r.venue), {
        positions: r.positions.map((p) => ({ underlying: getAddress(p.underlying), tokens: BigInt(p.tokens) })),
        equityUsd: BigInt(r.equityUsd),
        flowInSeen: BigInt(r.flowInSeen),
      }),
  );
}

async function main() {
  const config = loadConfig();
  const rpc = need(config, "TREASURY_RPC_URL");
  const pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const chainId = await pub.getChainId();
  const account = getAddress(need(config, "TREASURY_ACCOUNT"));
  const readers = staticReaders(config.RISK_STATIC_READERS);

  let pusher: MirrorPusher | undefined;
  const mirror = config.TREASURY_POSITION_MIRROR;
  if (mirror && readers.length > 0) {
    const controller = loadDeskAccount("TREASURY_CONTROLLER", config.env);
    const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
    const wallet = createWalletClient({ account: controller, chain, transport: http(rpc) });
    pusher = new MirrorPusher(pub, wallet, controller, getAddress(mirror) as Address);
  }
  const urls = [...config.RISK_WEBHOOK_URLS];
  if (config.WEBHOOK_ALLOW_PRIVATE && chainId === 4663) throw new Error("WEBHOOK_ALLOW_PRIVATE=1 is refused on mainnet");
  const allowPrivate = config.WEBHOOK_ALLOW_PRIVATE;
  const direct = urls.length ? new Webhooks({ urls, secret: config.RISK_WEBHOOK_SECRET, allowPrivate }) : undefined;
  // Subscribed webhooks only when a database is named explicitly (the risk service runs without Postgres).
  const subscribed = isSet("DATABASE_URL") ? new WebhookDispatcher(connect(config.DATABASE_URL).db, { chainId, allowPrivate }) : undefined;
  const webhooks = fanout(direct, subscribed);
  const svc = new RiskService(
    pub,
    { account, readers, hysteresisBps: config.RISK_HYSTERESIS_BPS },
    { pusher, webhooks, log: (m, x) => console.log(stringify({ at: new Date().toISOString(), msg: m, ...((x as object) ?? {}) })) },
  );

  const interval = config.RISK_INTERVAL_SEC * 1000;
  let ticks = 0;
  if (!config.RISK_ONCE) {
    const health = serveHealth("treasury-risk", config.TREASURY_RISK_PORT, () => ({ chainId, ticks }));
    console.log(stringify({ at: new Date().toISOString(), msg: `risk every ${interval / 1000} s, /health on :${health.port}`, config: safeConfigSummary(config, keysFor("TREASURY_", "RISK_", "LOG_")) }));
  }
  for (;;) {
    try {
      const r = await svc.tick();
      ticks++;
      if (config.RISK_ONCE) {
        console.log(stringify(r));
        return;
      }
    } catch (err) {
      console.error(stringify({ at: new Date().toISOString(), msg: "tick failed", error: err instanceof Error ? err.message : String(err) }));
      if (config.RISK_ONCE) process.exit(1);
    }
    await Bun.sleep(interval);
  }
}

if (import.meta.main) await main();
