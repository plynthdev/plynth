// bun run treasury-desks           -> runs the cash and equity desks every TREASURY_DESK_INTERVAL_S (default 300),
//                                     GET /health on TREASURY_DESKS_PORT (default 8793)
// bun run treasury-desks --once    -> one pass, then exit (tests use this)
//
// Env (config.ts): TREASURY_CONFIG (desk config JSON, see treasury/desks/runner-config.ts), TREASURY_RPC_URL (overrides the config's rpcUrl),
// DATABASE_URL (desk_actions), TREASURY_CASH_DESK_KEY | _KEYSTORE (+ _KEYSTORE_PASSWORD[_FILE]),
// TREASURY_EQUITY_DESK_KEY | _KEYSTORE (+ ...). Keys are never logged.
// Jury: TREASURY_JURY=off disables it; OLLAMA_HOST, TREASURY_JURY_MODELS, TREASURY_JURY_TIMEOUT_MS.
// A rule-9 rejection (needs the board) is filed as a BoardApprovals ticket with the jury's verdict attached;
// without Ollama the rule juror alone runs.
import { keysFor, loadConfig, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { serveHealth } from "@/lib/health";
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from "viem";
import { JuryService, juryExceptionHandler, PgJuryStore } from "@/treasury/jury";
import { loadConfig as loadRunnerConfig } from "@/treasury/desks/runner-config";
import { loadDeskAccount } from "@/treasury/desks/keys";
import { PgActionLog } from "@/treasury/desks/log";
import { runOnce, type DeskContext } from "@/treasury/desks/runner";

const once = process.argv.includes("--once");
const config = loadConfig();
const cfgPath = config.TREASURY_CONFIG;
if (!cfgPath) throw new Error("TREASURY_CONFIG is required");
const cfg = loadRunnerConfig(cfgPath);
const rpcUrl = config.TREASURY_RPC_URL ?? cfg.rpcUrl;
if (!rpcUrl) throw new Error("set TREASURY_RPC_URL or rpcUrl in the desk config");

const transport = http(rpcUrl, { timeout: 30_000 });
const probe = createPublicClient({ transport });
const id = await probe.getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = config.TREASURY_POLL_MS ?? (id === 31337 ? 100 : 2000);
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const cashAccount = loadDeskAccount("TREASURY_CASH_DESK", config.env);
const equityAccount = loadDeskAccount("TREASURY_EQUITY_DESK", config.env);
const { db, close } = connect(databaseUrl());
const say = (m: string) => console.log(`[desks ${id}] ${m}`);
const ctx: DeskContext = {
  chain,
  pub,
  cfg,
  cash: { account: cashAccount, wallet: createWalletClient({ chain, transport, account: cashAccount, pollingInterval }) },
  equity: { account: equityAccount, wallet: createWalletClient({ chain, transport, account: equityAccount, pollingInterval }) },
  log: new PgActionLog(db),
  say,
};
if (config.TREASURY_JURY !== "off") {
  const store = new PgJuryStore(db);
  ctx.onException = juryExceptionHandler(JuryService.fromEnv(config.env, { store, log: (m) => say(`jury: ${m}`) }), store);
}

async function pass() {
  const r = await runOnce(ctx);
  const sent = [...r.equity.outcomes, ...r.cash].filter((o) => o.ok).length;
  const rejected = [...r.equity.outcomes, ...r.cash].filter((o) => !o.ok).length;
  say(`pass done: beacon=[${r.equity.beacon.join(",")}] rebalanced=${r.equity.rebalanced}${r.equity.skipped ? ` skipped=${r.equity.skipped}` : ""} sent=${sent} rejected=${rejected}`);
}

if (once) {
  try {
    await pass();
  } finally {
    await close();
  }
  process.exit(0);
}

const interval = config.TREASURY_DESK_INTERVAL_S * 1000;
let passes = 0;
const health = serveHealth("treasury-desks", config.TREASURY_DESKS_PORT, () => ({ chainId: id, passes }));
say(`every ${interval / 1000} s, /health on :${health.port} ${JSON.stringify(safeConfigSummary(config, keysFor("TREASURY_", "OLLAMA_", "LOG_")))}`);
for (;;) {
  try {
    await pass();
    passes++;
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
