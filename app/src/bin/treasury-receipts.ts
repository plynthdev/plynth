// bun run treasury-receipts          -> every TREASURY_RECEIPTS_INTERVAL_S (default 300) closes finished hours;
//                                       GET /health on TREASURY_RECEIPTS_PORT (default 8796)
// bun run treasury-receipts --once   -> one pass, then exit (tests use this)
//
// Env (config.ts): TREASURY_RPC_URL, TREASURY_RECEIPTS (Receipts address), DATABASE_URL, TREASURY_CONTROLLER_KEY | _KEYSTORE,
// and the treasuries: TREASURY_ACCOUNTS (comma-separated) or TREASURY_FACTORY (every treasury it created).
// TREASURY_RECEIPTS_GRACE_S (default 300): how long after an hour ends before it is closed.
import { keysFor, loadConfig, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { serveHealth } from "@/lib/health";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadDeskAccount } from "@/treasury/desks/keys";
import { treasuriesFromEnv } from "@/treasury/valuer/service";
import { receiptsOnce } from "@/treasury/receipts/service";
import { ReceiptStore } from "@/treasury/receipts/store";

const once = process.argv.includes("--once");
const config = loadConfig();
const rpcUrl = config.TREASURY_RPC_URL;
const addr = config.TREASURY_RECEIPTS;
if (!rpcUrl || !addr) throw new Error("TREASURY_RPC_URL and TREASURY_RECEIPTS are required");
const transport = http(rpcUrl, { timeout: 30_000 });
const id = await createPublicClient({ transport }).getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = config.TREASURY_POLL_MS ?? (id === 31337 ? 100 : 2000);
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const controller = loadDeskAccount("TREASURY_CONTROLLER", config.env);
const { db, close } = connect(databaseUrl());
const say = (m: string) => console.log(`[receipts ${id}] ${m}`);
const store = new ReceiptStore(db);
const wallet = createWalletClient({ chain, transport, account: controller, pollingInterval });
const graceSeconds = config.TREASURY_RECEIPTS_GRACE_S;

async function pass() {
  const accounts = await treasuriesFromEnv(pub, config.env);
  const r = await receiptsOnce({ chain, pub, wallet, controller, receipts: getAddress(addr!), store, accounts, graceSeconds, say });
  say(`pass done: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return r;
}

if (once) {
  let code = 0;
  try {
    if ((await pass()).some((r) => r.status === "failed")) code = 1;
  } finally {
    await close();
  }
  process.exit(code);
}
const interval = config.TREASURY_RECEIPTS_INTERVAL_S * 1000;
let passes = 0;
const health = serveHealth("treasury-receipts", config.TREASURY_RECEIPTS_PORT, () => ({ chainId: id, passes }));
say(`every ${interval / 1000} s, /health on :${health.port} ${JSON.stringify(safeConfigSummary(config, keysFor("TREASURY_", "LOG_")))}`);
for (;;) {
  try {
    await pass();
    passes++;
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
