// bun run keeper          -> a pass every KEEPER_INTERVAL_MS (default 30 s), GET /health on KEEPER_PORT (default 8788)
// bun run keeper --once   -> one pass, print the report, exit (tests use this); exit 1 if any job failed
//
// Env: KEEPER_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// KEEPER_DEPLOYMENTS_DIR (default ./deployments), KEEPER_SECRET_KEY (32 bytes hex/base64, seals beacon secrets),
// KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE + KEEPER_KEYSTORE_PASSWORD_FILE, KEEPER_LOOKAHEAD (windows, default 2),
// KEEPER_JOBS (comma-separated subset of topups,roundups,spends,sweep,beacon,execute,deliver-quiet,deliver-hidden; default all),
// PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV=sandbox|production, default sandbox) to sync linked Plaid items,
// SPLIT_PARTS (Quiet delivery parts per allocation, 1-3, default 2).
// The signing key is never logged.
import { robinhood, robinhoodTestnet } from "@plynth/chain";
import { connect, databaseUrl } from "@plynth/db";
import { readDeployment } from "@plynth/indexer";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from "viem";
import { keeperDeployment, type Ctx } from "./context";
import { healthApp } from "./health";
import { JOBS, runPass, type PassReport } from "./keeper";
import { parseSecretKey, Sealer } from "./seal";
import { Sender } from "./sender";
import { splitParts } from "./jobs/quiet";
import { loadSigner } from "./signer";
import { plaidFromEnv } from "./sources/plaid";

const once = process.argv.includes("--once");
const chainName = process.env.KEEPER_CHAIN || "local";
if (!["local", "testnet", "mainnet"].includes(chainName)) throw new Error(`bad KEEPER_CHAIN ${chainName}`);
const rpcUrl =
  chainName === "mainnet"
    ? process.env.RHC_MAINNET_RPC_URL || robinhood.rpcUrls.default.http[0]
    : chainName === "testnet"
      ? process.env.RHC_TESTNET_RPC_URL || robinhoodTestnet.rpcUrls.default.http[0]
      : process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";

const account = loadSigner(process.env);
const sealer = await Sealer.create(parseSecretKey(process.env.KEEPER_SECRET_KEY));
const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl!] } } });
// The sender retries itself (backoff + nonce resync), so the transport does not.
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }), pollingInterval: chainName === "local" ? 50 : 1_000 }) as PublicClient;
const wallet = createWalletClient({ chain, account, transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }) });

const dep = keeperDeployment(readDeployment(process.env.KEEPER_DEPLOYMENTS_DIR || join(import.meta.dir, "..", "..", "..", "deployments"), chainId), chainId);
const { db, close } = connect(databaseUrl());
const log = (m: string) => console.log(`[keeper ${chainId}] ${m}`);
const sender = new Sender(
  {
    estimateGas: (a) => pub.estimateGas(a),
    estimateFeesPerGas: () => pub.estimateFeesPerGas(),
    getTransactionCount: (a) => pub.getTransactionCount(a),
    sendTransaction: (tx) => wallet.sendTransaction({ ...tx, account, chain }),
    waitForTransactionReceipt: (a) => pub.waitForTransactionReceipt({ ...a, timeout: 120_000 }),
  },
  account.address,
);
const ctx: Ctx = { chainId, db, pub, account: account.address, sender, sealer, dep, lookahead: Number(process.env.KEEPER_LOOKAHEAD || 2), splitParts: splitParts(process.env.SPLIT_PARTS), plaid: plaidFromEnv(process.env)?.api, log };

const only = (process.env.KEEPER_JOBS || "").split(",").map((s) => s.trim()).filter(Boolean);
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

const intervalMs = Number(process.env.KEEPER_INTERVAL_MS || 30_000);
let last: PassReport | undefined;
const port = Number(process.env.KEEPER_PORT ?? 8788);
const server = Bun.serve({ port, fetch: healthApp({ chainId, keeper: account.address, last: () => last, head: () => pub.getBlockNumber(), intervalMs }).fetch });
log(`keeper ${account.address}, ${dep.stocks.length} assets, every ${intervalMs} ms, /health on :${server.port}`);
for (;;) {
  last = await runPass(ctx, jobs);
  print(last);
  await Bun.sleep(intervalMs);
}
