// bun run indexer          -> runs forever, serves GET /health on INDEXER_PORT (default 8787)
// bun run indexer --once   -> one pass over every stream, then exit (tests use this)
//
// Env (config.ts): INDEXER_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// INDEXER_CONFIRMATIONS (default 12; 0 on local), INDEXER_DEPLOYMENTS_DIR (default app/deployments),
// INDEXER_FROM_BLOCK, INDEXER_WALLETS (comma-separated linked wallets), INDEXER_STREAMS_FILE (extra streams JSON),
// INDEXER_POLL_MS (default 2000).
//
// Each pass has two phases: (1) the static streams (deployment contracts, INDEXER_WALLETS, extras), then
// (2) one USDG Transfer(from = wallet) stream per spending wallet linked in the SavingsVault, read from the
// WalletLinked logs phase 1 just stored. So a wallet linked in this pass is indexed in this same pass.
import { keysFor, loadConfig, rpcUrlFor, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";
import { loadStreams, readDeployment, spendStreams, type ChainName, type ExtraStream, type Stream } from "@/indexer/handlers/streams";
import { healthApp } from "@/indexer/health";
import { Indexer, type PassResult } from "@/indexer/indexer";
import { linkedWallets } from "@/indexer/linked";
import { sleep } from "@/indexer/retry";

const once = process.argv.includes("--once");
const config = loadConfig();
const chain: ChainName = config.INDEXER_CHAIN;
const rpcUrl = rpcUrlFor(config, chain);

// Retries are ours (backoff with jitter, chunk halving), so the transport does not retry.
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }) }) as PublicClient;
const chainId = await client.getChainId();
const confirmations = BigInt(config.INDEXER_CONFIRMATIONS ?? (chain === "local" ? 0 : 12));

const deploymentsDir = config.INDEXER_DEPLOYMENTS_DIR;
const dep = readDeployment(deploymentsDir, chainId);
const extra: ExtraStream[] = config.INDEXER_STREAMS_FILE ? JSON.parse(readFileSync(config.INDEXER_STREAMS_FILE, "utf8")) : [];
const streams = loadStreams({
  chain,
  chainId,
  deploymentsDir,
  fromBlock: config.INDEXER_FROM_BLOCK ? BigInt(config.INDEXER_FROM_BLOCK) : undefined,
  wallets: [...config.INDEXER_WALLETS],
  extra,
});

const { db, close } = connect(databaseUrl());
const log = (m: string) => console.log(`[indexer ${chainId}] ${m}`);
const indexer = new Indexer({ client, db, chainId, streams, confirmations, log });

// Phase 2: spending-wallet streams. Rebuilt only when the set of linked wallets changes.
let spendKey = "";
let spendIndexer: Indexer | undefined;
let spendOnly: Stream[] = [];
async function spendPass(): Promise<PassResult[]> {
  const vault = typeof dep?.savingsVault === "string" ? dep.savingsVault : undefined;
  if (!vault || typeof dep?.usdg !== "string") return [];
  const wallets = await linkedWallets(db, chainId, vault);
  const key = wallets.map((w) => `${w.wallet}@${w.fromBlock}`).join(",");
  if (key !== spendKey) {
    spendKey = key;
    spendOnly = spendStreams(chainId, chain, dep.usdg, wallets);
    // The static streams are passed too so a reorg rewind keeps every cursor's fromBlock floor.
    spendIndexer = spendOnly.length ? new Indexer({ client, db, chainId, streams: [...streams, ...spendOnly], confirmations, log }) : undefined;
  }
  if (!spendIndexer) return [];
  const head = await spendIndexer.safeHead();
  const out: PassResult[] = [];
  for (const s of spendOnly) out.push(await spendIndexer.syncStream(s, head));
  return out;
}

if (once) {
  try {
    const res = [...(await indexer.runOnce()), ...(await spendPass())];
    for (const r of res) log(`${r.stream}: blocks ${r.fromBlock}..${r.toBlock}, ${r.logs} logs, ${r.reorgs} reorgs`);
  } finally {
    await close();
  }
  process.exit(0);
}

const port = config.INDEXER_PORT;
const app = healthApp({ db, chainId, streams, safeHead: () => indexer.safeHead() });
Bun.serve({ port, fetch: app.fetch });
log(`${streams.length} streams, confirmations ${confirmations}, /health on :${port} ${JSON.stringify(safeConfigSummary(config, keysFor("INDEXER_", "LOG_")))}`);
const pollMs = config.INDEXER_POLL_MS;
for (;;) {
  try {
    await indexer.runOnce();
    await spendPass();
  } catch (err) {
    log(`pass failed: ${(err as Error)?.message ?? err}`);
  }
  await sleep(pollMs);
}
