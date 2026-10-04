// bun run indexer          -> runs forever, serves GET /health on INDEXER_PORT (default 8787)
// bun run indexer --once   -> one pass over every stream, then exit (tests use this)
//
// Env: INDEXER_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// INDEXER_CONFIRMATIONS (default 12; 0 on local), INDEXER_DEPLOYMENTS_DIR (default ./deployments),
// INDEXER_FROM_BLOCK, INDEXER_WALLETS (comma-separated linked wallets), INDEXER_STREAMS_FILE (extra streams JSON),
// INDEXER_POLL_MS (default 2000).
//
// Each pass has two phases: (1) the static streams (deployment contracts, INDEXER_WALLETS, extras), then
// (2) one USDG Transfer(from = wallet) stream per spending wallet linked in the SavingsVault, read from the
// WalletLinked logs phase 1 just stored. So a wallet linked in this pass is indexed in this same pass.
import { connect, databaseUrl } from "@plynth/db";
import { robinhood, robinhoodTestnet } from "@plynth/chain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { loadStreams, readDeployment, spendStreams, type ChainName, type ExtraStream, type Stream } from "./config";
import { healthApp } from "./health";
import { Indexer, type PassResult } from "./indexer";
import { linkedWallets } from "./linked";
import { sleep } from "./retry";

const once = process.argv.includes("--once");
const chain = (process.env.INDEXER_CHAIN || "local") as ChainName;
if (!["local", "testnet", "mainnet"].includes(chain)) throw new Error(`bad INDEXER_CHAIN ${chain}`);

const rpcUrl =
  chain === "mainnet"
    ? process.env.RHC_MAINNET_RPC_URL || robinhood.rpcUrls.default.http[0]
    : chain === "testnet"
      ? process.env.RHC_TESTNET_RPC_URL || robinhoodTestnet.rpcUrls.default.http[0]
      : process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";

// Retries are ours (backoff with jitter, chunk halving), so the transport does not retry.
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }) }) as PublicClient;
const chainId = await client.getChainId();
const confirmations = BigInt(process.env.INDEXER_CONFIRMATIONS ?? (chain === "local" ? "0" : "12"));

const deploymentsDir = process.env.INDEXER_DEPLOYMENTS_DIR || join(import.meta.dir, "..", "..", "..", "deployments");
const dep = readDeployment(deploymentsDir, chainId);
const extra: ExtraStream[] = process.env.INDEXER_STREAMS_FILE ? JSON.parse(readFileSync(process.env.INDEXER_STREAMS_FILE, "utf8")) : [];
const streams = loadStreams({
  chain,
  chainId,
  deploymentsDir,
  fromBlock: process.env.INDEXER_FROM_BLOCK ? BigInt(process.env.INDEXER_FROM_BLOCK) : undefined,
  wallets: (process.env.INDEXER_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean),
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

const port = Number(process.env.INDEXER_PORT || 8787);
const app = healthApp({ db, chainId, streams, safeHead: () => indexer.safeHead() });
Bun.serve({ port, fetch: app.fetch });
log(`${streams.length} streams, confirmations ${confirmations}, /health on :${port}`);
const pollMs = Number(process.env.INDEXER_POLL_MS || 2000);
for (;;) {
  try {
    await indexer.runOnce();
    await spendPass();
  } catch (err) {
    log(`pass failed: ${(err as Error)?.message ?? err}`);
  }
  await sleep(pollMs);
}
