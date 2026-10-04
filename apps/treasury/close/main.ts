// bun run treasury:close           -> checks every TREASURY_CLOSE_INTERVAL_S (default 600) and commits a period
//                                     statement once it is due and the held feeds are fresh
// bun run treasury:close --once    -> one pass, then exit (tests use this)
//
// Env: TREASURY_RPC_URL, TREASURY_PERIOD_CLOSE (PeriodClose address), DATABASE_URL (closes, desk_actions),
// TREASURY_CONTROLLER_KEY | _KEYSTORE (+ _KEYSTORE_PASSWORD[_FILE]). The key is never logged.
import { connect, databaseUrl } from "@plynth/db";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadDeskAccount } from "../desks/keys";
import { closeOnce } from "./service";
import { CloseStore } from "./store";

const once = process.argv.includes("--once");
const rpcUrl = process.env.TREASURY_RPC_URL;
const pcAddr = process.env.TREASURY_PERIOD_CLOSE;
if (!rpcUrl || !pcAddr) throw new Error("TREASURY_RPC_URL and TREASURY_PERIOD_CLOSE are required");

const transport = http(rpcUrl, { timeout: 30_000 });
const id = await createPublicClient({ transport }).getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = Number(process.env.TREASURY_POLL_MS || (id === 31337 ? 100 : 2000));
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const controller = loadDeskAccount("TREASURY_CONTROLLER");
const { db, close } = connect(databaseUrl());
const say = (m: string) => console.log(`[close ${id}] ${m}`);
const ctx = {
  chain,
  pub,
  controller,
  wallet: createWalletClient({ chain, transport, account: controller, pollingInterval }),
  periodClose: getAddress(pcAddr),
  store: new CloseStore(db),
  say,
};

async function pass() {
  const r = await closeOnce(ctx);
  say(`pass done: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return r;
}

if (once) {
  let code = 0;
  try {
    const r = await pass();
    if (r.status === "failed") code = 1;
  } finally {
    await close();
  }
  process.exit(code);
}

const interval = Number(process.env.TREASURY_CLOSE_INTERVAL_S || 600) * 1000;
for (;;) {
  try {
    await pass();
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
