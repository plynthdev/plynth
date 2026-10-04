// Runs the risk service in a loop.
//
// Env:
//   TREASURY_RPC_URL                 RPC (anvil / fork / testnet)
//   TREASURY_ACCOUNT                 the TreasuryAccount address
//   TREASURY_POSITION_MIRROR         PositionMirror address (optional; needed to push snapshots)
//   TREASURY_CONTROLLER_KEY | _KEYSTORE + _PASSWORD(_FILE)   the policy controller (signs mirror snapshots)
//   RISK_STATIC_READERS              optional JSON file: [{ venue, positions:[{underlying,tokens}], equityUsd, flowInSeen }]
//                                    (stand-in until the Orderly/Arcus readers of todo 29 exist)
//   RISK_WEBHOOK_URLS                comma-separated URLs for drawdown.state / risk.alert
//   RISK_WEBHOOK_SECRET              HMAC secret for x-plinth-signature
//   DATABASE_URL                     optional: also deliver drawdown.state/risk.alert to treasury_webhooks subscribers
//   RISK_INTERVAL_SEC                tick interval (default 30)
//   RISK_HYSTERESIS_BPS              drawdown hysteresis (default 50)
//   RISK_ONCE=1                      one tick, print the report, exit
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, type Address, type PublicClient } from "viem";
import { loadDeskAccount } from "../desks/keys";
import { MirrorPusher, StaticVenueReader, type VenueReader } from "./mirror";
import { RiskService } from "./service";
import { connect } from "@plynth/db";
import { WebhookDispatcher } from "../webhooks/dispatcher";
import { fanout, stringify, Webhooks } from "./webhooks";

function need(name: string): string {
  const v = process.env[name];
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
  const rpc = need("TREASURY_RPC_URL");
  const pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const chainId = await pub.getChainId();
  const account = getAddress(need("TREASURY_ACCOUNT"));
  const readers = staticReaders(process.env.RISK_STATIC_READERS);

  let pusher: MirrorPusher | undefined;
  const mirror = process.env.TREASURY_POSITION_MIRROR;
  if (mirror && readers.length > 0) {
    const controller = loadDeskAccount("TREASURY_CONTROLLER");
    const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
    const wallet = createWalletClient({ account: controller, chain, transport: http(rpc) });
    pusher = new MirrorPusher(pub, wallet, controller, getAddress(mirror) as Address);
  }
  const urls = (process.env.RISK_WEBHOOK_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const direct = urls.length ? new Webhooks({ urls, secret: process.env.RISK_WEBHOOK_SECRET }) : undefined;
  const subscribed = process.env.DATABASE_URL ? new WebhookDispatcher(connect(process.env.DATABASE_URL).db, { chainId }) : undefined;
  const webhooks = fanout(direct, subscribed);
  const svc = new RiskService(
    pub,
    { account, readers, hysteresisBps: Number(process.env.RISK_HYSTERESIS_BPS ?? 50) },
    { pusher, webhooks, log: (m, x) => console.log(stringify({ at: new Date().toISOString(), msg: m, ...((x as object) ?? {}) })) },
  );

  const interval = Number(process.env.RISK_INTERVAL_SEC ?? 30) * 1000;
  for (;;) {
    try {
      const r = await svc.tick();
      if (process.env.RISK_ONCE === "1") {
        console.log(stringify(r));
        return;
      }
    } catch (err) {
      console.error(stringify({ at: new Date().toISOString(), msg: "tick failed", error: err instanceof Error ? err.message : String(err) }));
      if (process.env.RISK_ONCE === "1") process.exit(1);
    }
    await Bun.sleep(interval);
  }
}

if (import.meta.main) await main();
