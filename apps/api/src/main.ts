// bun run api   -> serves the dashboard API on API_PORT (default 8789): tRPC at /trpc, REST mirror at /v1.
//
// Env: API_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// API_DEPLOYMENTS_DIR (default ./deployments), CORS_ORIGINS (comma-separated; default the Lovable app +
// http://localhost:5173). Read-only: no keys, no writes to keeper or indexer tables, except the optional
// eligibility routes (ELIGIBILITY_*), which hold the attester key and write eligibility_decisions, and the
// round-up source routes (ROUNDUPS_ENABLED=1, PLAID_*, KEEPER_SECRET_KEY), which write roundup_*.
import { robinhood, robinhoodTestnet } from "@plynth/chain";
import { connect, databaseUrl } from "@plynth/db";
import { readDeployment } from "@plynth/indexer";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { eligibilityFromEnv } from "@plynth/eligibility";
import { corsOrigins, createApp } from "./app";
import { BlockTimes } from "./block-times";
import { apiDeployment } from "./deployment";
import { roundupsFromEnv } from "./roundups";

const chainName = process.env.API_CHAIN || "local";
if (!["local", "testnet", "mainnet"].includes(chainName)) throw new Error(`bad API_CHAIN ${chainName}`);
const rpcUrl =
  chainName === "mainnet"
    ? process.env.RHC_MAINNET_RPC_URL || robinhood.rpcUrls.default.http[0]
    : chainName === "testnet"
      ? process.env.RHC_TESTNET_RPC_URL || robinhoodTestnet.rpcUrls.default.http[0]
      : process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";

// Public RPCs rate-limit per request: batch eth_calls through Multicall3 where the chain has it.
const pub = createPublicClient({
  transport: http(rpcUrl, { retryCount: 3, retryDelay: 500, timeout: 20_000 }),
  batch: chainName === "local" ? undefined : { multicall: true },
}) as PublicClient;
const chainId = await pub.getChainId();
const dep = apiDeployment(readDeployment(process.env.API_DEPLOYMENTS_DIR || join(import.meta.dir, "..", "..", "..", "deployments"), chainId), chainId);
const { db } = connect(databaseUrl());
// Eligibility screening (POST /v1/eligibility/check) is enabled when ELIGIBILITY_REGISTRY is set; it then
// needs the attester key (see apps/eligibility/src/config.ts). The rest of the API stays keyless.
const elig = eligibilityFromEnv(process.env, { chainId, pub, db });
// Round-up sources (statement import, Plaid link) when ROUNDUPS_ENABLED=1; see src/roundups.ts.
const roundups = await roundupsFromEnv(process.env, { chainId, db, pub });
const app = createApp({ chainId, pub, db, dep, blockTimes: new BlockTimes(pub) }, { corsOrigins: corsOrigins(process.env.CORS_ORIGINS), eligibility: elig?.routes, roundups });
const server = Bun.serve({ port: Number(process.env.API_PORT ?? 8789), fetch: app.fetch });
console.log(`[api ${chainId}] listening on :${server.port}`);
