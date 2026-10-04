// bun run treasury:desks           -> runs the cash and equity desks every TREASURY_DESK_INTERVAL_S (default 300)
// bun run treasury:desks --once    -> one pass, then exit (tests use this)
//
// Env: TREASURY_CONFIG (desk config JSON, see config.ts), TREASURY_RPC_URL (overrides the config's rpcUrl),
// DATABASE_URL (desk_actions), TREASURY_CASH_DESK_KEY | _KEYSTORE (+ _KEYSTORE_PASSWORD[_FILE]),
// TREASURY_EQUITY_DESK_KEY | _KEYSTORE (+ ...). Keys are never logged.
// Jury (todo 26): TREASURY_JURY=off disables it; OLLAMA_HOST, TREASURY_JURY_MODELS, TREASURY_JURY_TIMEOUT_MS.
// A rule-9 rejection (needs the board) is filed as a BoardApprovals ticket with the jury's verdict attached;
// without Ollama the rule juror alone runs.
import { connect, databaseUrl } from "@plynth/db";
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from "viem";
import { JuryService, juryExceptionHandler, PgJuryStore } from "../jury";
import { loadConfig } from "./config";
import { loadDeskAccount } from "./keys";
import { PgActionLog } from "./log";
import { runOnce, type DeskContext } from "./runner";

const once = process.argv.includes("--once");
const cfgPath = process.env.TREASURY_CONFIG;
if (!cfgPath) throw new Error("TREASURY_CONFIG is required");
const cfg = loadConfig(cfgPath);
const rpcUrl = process.env.TREASURY_RPC_URL || cfg.rpcUrl;
if (!rpcUrl) throw new Error("set TREASURY_RPC_URL or rpcUrl in the desk config");

const transport = http(rpcUrl, { timeout: 30_000 });
const probe = createPublicClient({ transport });
const id = await probe.getChainId();
const chain = defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pollingInterval = Number(process.env.TREASURY_POLL_MS || (id === 31337 ? 100 : 2000));
const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
const cashAccount = loadDeskAccount("TREASURY_CASH_DESK");
const equityAccount = loadDeskAccount("TREASURY_EQUITY_DESK");
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
if (process.env.TREASURY_JURY !== "off") {
  const store = new PgJuryStore(db);
  ctx.onException = juryExceptionHandler(JuryService.fromEnv(process.env, { store, log: (m) => say(`jury: ${m}`) }), store);
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

const interval = Number(process.env.TREASURY_DESK_INTERVAL_S || 300) * 1000;
for (;;) {
  try {
    await pass();
  } catch (e) {
    say(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(interval);
}
