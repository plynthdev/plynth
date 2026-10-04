// bun run treasury-close           -> checks every TREASURY_CLOSE_INTERVAL_S (default 600) and commits a period
//                                     statement once it is due and the held feeds are fresh; GET /health on
//                                     TREASURY_CLOSE_PORT (default 8794)
// bun run treasury-close --once    -> one pass, then exit (tests use this)
//
// Env (config.ts): TREASURY_RPC_URL, TREASURY_PERIOD_CLOSE (PeriodClose address), DATABASE_URL (closes, desk_actions),
// TREASURY_CONTROLLER_KEY | _KEYSTORE (+ _KEYSTORE_PASSWORD[_FILE]). The key is never logged.
import { keysFor, loadConfig, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { serveHealth } from "@/lib/health";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadDeskAccount } from "@/treasury/desks/keys";
import { PgExceptionStore } from "@/treasury/reconciler/store";
import { periodCloseAbi } from "@/abi/treasury-close";
import { closeOnce } from "@/treasury/close/service";
import { CloseStore } from "@/treasury/close/store";

const once = process.argv.includes("--once");
const config = loadConfig();
const rpcUrl = config.TREASURY_RPC_URL;
const pcAddr = config.TREASURY_PERIOD_CLOSE;
if (!rpcUrl || !pcAddr) throw new Error("TREASURY_RPC_URL and TREASURY_PERIOD_CLOSE are required");

const transport = http(rpcUrl, { timeout: 30_000 });
const id = await createPublicClient({ transport }).getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = config.TREASURY_POLL_MS ?? (id === 31337 ? 100 : 2000);
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const controller = loadDeskAccount("TREASURY_CONTROLLER", config.env);
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
  breaks: undefined as { count(): Promise<number> } | undefined,
};
// Reconciler gate: open breaks of this PeriodClose's account block the commit (TREASURY_CLOSE_SKIP_RECONCILE=1
// turns it off for a T1 treasury with no perp venues and no reconciler running).
if (!config.TREASURY_CLOSE_SKIP_RECONCILE) {
  const acct = await pub.readContract({ address: ctx.periodClose, abi: periodCloseAbi, functionName: "account" });
  const exc = new PgExceptionStore(db);
  ctx.breaks = { count: async () => (await exc.open(id, acct)).length };
}

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

const interval = config.TREASURY_CLOSE_INTERVAL_S * 1000;
let last: string | undefined;
const health = serveHealth("treasury-close", config.TREASURY_CLOSE_PORT, () => ({ chainId: id, last }));
say(`every ${interval / 1000} s, /health on :${health.port} ${JSON.stringify(safeConfigSummary(config, keysFor("TREASURY_", "LOG_")))}`);
for (;;) {
  try {
    last = (await pass()).status;
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
