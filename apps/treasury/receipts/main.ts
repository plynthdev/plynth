// bun run treasury:receipts          -> every TREASURY_RECEIPTS_INTERVAL_S (default 300) closes finished hours
// bun run treasury:receipts --once   -> one pass, then exit (tests use this)
//
// Env: TREASURY_RPC_URL, TREASURY_RECEIPTS (Receipts address), DATABASE_URL, TREASURY_CONTROLLER_KEY | _KEYSTORE,
// and the treasuries: TREASURY_ACCOUNTS (comma-separated) or TREASURY_FACTORY (every treasury it created).
// TREASURY_RECEIPTS_GRACE_S (default 300): how long after an hour ends before it is closed.
import { connect, databaseUrl } from "@plynth/db";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadDeskAccount } from "../desks/keys";
import { treasuriesFromEnv } from "../valuer/service";
import { receiptsOnce } from "./service";
import { ReceiptStore } from "./store";

const once = process.argv.includes("--once");
const rpcUrl = process.env.TREASURY_RPC_URL;
const addr = process.env.TREASURY_RECEIPTS;
if (!rpcUrl || !addr) throw new Error("TREASURY_RPC_URL and TREASURY_RECEIPTS are required");
const transport = http(rpcUrl, { timeout: 30_000 });
const id = await createPublicClient({ transport }).getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = Number(process.env.TREASURY_POLL_MS || (id === 31337 ? 100 : 2000));
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const controller = loadDeskAccount("TREASURY_CONTROLLER");
const { db, close } = connect(databaseUrl());
const say = (m: string) => console.log(`[receipts ${id}] ${m}`);
const store = new ReceiptStore(db);
const wallet = createWalletClient({ chain, transport, account: controller, pollingInterval });
const graceSeconds = Number(process.env.TREASURY_RECEIPTS_GRACE_S ?? 300);

async function pass() {
  const accounts = await treasuriesFromEnv(pub);
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
const interval = Number(process.env.TREASURY_RECEIPTS_INTERVAL_S || 300) * 1000;
for (;;) {
  try {
    await pass();
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
