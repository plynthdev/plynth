// bun run keeper          -> a pass every KEEPER_INTERVAL_MS (default 30 s), GET /health on KEEPER_PORT (default 8788)
// bun run keeper --once   -> one pass, print the report, exit (tests use this); exit 1 if any job failed
//
// Env (config.ts): KEEPER_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// KEEPER_DEPLOYMENTS_DIR (default app/deployments), KEEPER_SECRET_KEY (32 bytes hex/base64, seals beacon secrets),
// KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE + KEEPER_KEYSTORE_PASSWORD_FILE, KEEPER_LOOKAHEAD (windows, default 2),
// KEEPER_JOBS (comma-separated subset of refresh-mock-feeds,topups,roundups,spends,sweep,beacon,execute,deliver-quiet,
// deliver-hidden; default all), KEEPER_MOCK_FEED_* (refresh-mock-feeds on testnet kit deployments; mainnet feeds are
// read over RHC_MAINNET_RPC_URL),
// PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV=sandbox|production, default sandbox) to sync linked Plaid items,
// SPLIT_PARTS (Quiet delivery parts per allocation, 1-3, default 2).
// The signing key is never logged.
import { keysFor, loadConfig, rpcUrlFor, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { readDeployment } from "@/indexer";
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { keeperDeployment, type Ctx } from "@/keeper/context";
import { healthApp } from "@/keeper/health";
import { JOBS, runPass, type PassReport } from "@/keeper/keeper";
import { mainnetFeedReader } from "@/keeper/jobs/mock-feeds";
import { parseSecretKey, Sealer } from "@/keeper/seal";
import { Sender, viemSenderIO } from "@/keeper/sender";
import { loadSigner } from "@/keeper/signer";
import { plaidFromEnv } from "@/keeper/sources/plaid";

const once = process.argv.includes("--once");
const config = loadConfig();
const chainName = config.KEEPER_CHAIN;
const rpcUrl = rpcUrlFor(config, chainName);

const account = loadSigner(config.env);
const sealer = await Sealer.create(parseSecretKey(config.KEEPER_SECRET_KEY));
const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
// The sender retries itself (backoff + nonce resync), so the transport does not.
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }), pollingInterval: chainName === "local" ? 50 : 1_000 }) as PublicClient;

const dep = keeperDeployment(readDeployment(config.KEEPER_DEPLOYMENTS_DIR, chainId), chainId);
const { db, close } = connect(databaseUrl());
const log = (m: string) => console.log(`[keeper ${chainId}] ${m}`);
const sender = new Sender(viemSenderIO(pub, account, chainId), account.address, { pollMs: chainName === "local" ? 50 : 1_000 });
// Read only (refresh-mock-feeds): the real Chainlink feeds the testnet mock feeds track. Created lazily by viem,
// so a keeper on a non-mock deployment never contacts mainnet.
const mainnet = createPublicClient({ transport: http(rpcUrlFor(config, "mainnet"), { retryCount: 3, retryDelay: 1_000, timeout: 30_000 }) }) as PublicClient;
const mockFeeds = {
  reader: mainnetFeedReader(mainnet),
  intervalS: config.KEEPER_MOCK_FEED_INTERVAL_S,
  keepAlive: config.KEEPER_MOCK_FEED_KEEP_ALIVE,
  realStaleS: config.KEEPER_MOCK_FEED_REAL_STALE_S,
  alignBps: config.KEEPER_MOCK_FEED_ALIGN_BPS,
};
const ctx: Ctx = { chainId, db, pub, account: account.address, sender, sealer, dep, lookahead: config.KEEPER_LOOKAHEAD, splitParts: config.SPLIT_PARTS, plaid: plaidFromEnv(config.env)?.api, mockFeeds, log };

const only = config.KEEPER_JOBS;
for (const j of only) if (!JOBS.some(([n]) => n === j)) throw new Error(`unknown job in KEEPER_JOBS: ${j}`);
const jobs = only.length ? JOBS.filter(([n]) => only.includes(n)) : JOBS;

function print(r: PassReport) {
  for (const j of r.jobs) log(`${j.job}: ${j.ok ? "ok" : "FAILED"} actions=${j.actions}${j.error ? ` error=${j.error}` : ""}${j.notes.length ? ` notes=${JSON.stringify(j.notes)}` : ""}`);
}

if (once) {
  let ok = false;
  try {
    const r = await runPass(ctx, jobs);
    print(r);
    ok = r.ok;
  } finally {
    await close();
  }
  process.exit(ok ? 0 : 1);
}

const intervalMs = config.KEEPER_INTERVAL_MS;
let last: PassReport | undefined;
const port = config.KEEPER_PORT;
const server = Bun.serve({ port, fetch: healthApp({ chainId, keeper: account.address, last: () => last, head: () => pub.getBlockNumber(), intervalMs }).fetch });
log(`keeper ${account.address}, ${dep.stocks.length} assets, every ${intervalMs} ms, /health on :${server.port} ${JSON.stringify(safeConfigSummary(config, keysFor("KEEPER_", "SPLIT_", "PLAID_", "LOG_")))}`);
for (;;) {
  last = await runPass(ctx, jobs);
  print(last);
  await Bun.sleep(intervalMs);
}
