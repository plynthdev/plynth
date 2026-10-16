// bun run api   -> serves the dashboard API on API_PORT (default 8789): tRPC at /trpc, REST mirror at /v1.
//
// Env (config.ts): API_CHAIN=local|testnet|mainnet (default local), DATABASE_URL, LOCAL_RPC_URL / RHC_*_RPC_URL,
// API_DEPLOYMENTS_DIR (default app/deployments), CORS_ORIGINS (comma-separated; default the Lovable app +
// http://localhost:5173). Read-only: no keys, no writes to keeper or indexer tables, except the optional
// eligibility routes (ELIGIBILITY_*), which hold the attester key and write eligibility_decisions, and the
// round-up source routes (ROUNDUPS_ENABLED=1, PLAID_*, KEEPER_SECRET_KEY), which write roundup_*.
import { keysFor, loadConfig, rpcUrlFor, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { readDeployment } from "@/indexer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { eligibilityFromEnv } from "@/eligibility";
import { corsOrigins, createApp } from "@/api/app";
import { BlockTimes } from "@/chain/block-times";
import { apiDeployment } from "@/chain/deployment";
import { roundupsFromEnv } from "@/api/routes/roundups";
import { clientIp } from "@/lib/ratelimit";
import { getConnInfo } from "hono/bun";
import type { Context } from "hono";

const config = loadConfig();
const chainName = config.API_CHAIN;
const rpcUrl = rpcUrlFor(config, chainName);

// Public RPCs rate-limit per request: batch eth_calls through Multicall3 where the chain has it.
const pub = createPublicClient({
  transport: http(rpcUrl, { retryCount: 3, retryDelay: 500, timeout: 20_000 }),
  batch: chainName === "local" ? undefined : { multicall: true },
}) as PublicClient;
const chainId = await pub.getChainId();
const depDir = config.API_DEPLOYMENTS_DIR;
// deployments/<chainid>-treasury.json (TreasuryFactory.s.sol) adds the treasury factory when present.
const treasuryFile = join(depDir, `${chainId}-treasury.json`);
const baseDep = readDeployment(depDir, chainId);
const dep = apiDeployment(baseDep && existsSync(treasuryFile) ? { ...baseDep, ...JSON.parse(readFileSync(treasuryFile, "utf8")), chainId } : baseDep, chainId);
const { db } = connect(databaseUrl());
// Eligibility screening (POST /v1/eligibility/check) is enabled when ELIGIBILITY_REGISTRY is set; it then
// needs the attester key (see app/src/eligibility/setup.ts). The rest of the API stays keyless.
const elig = eligibilityFromEnv(config.env, { chainId, pub, db });
// The client address for rate limits: behind Caddy (API_TRUST_PROXY=1) the X-Forwarded-For Caddy sets, else the socket.
const ipOf = (c: Context) => clientIp(c.req.raw.headers, config.API_TRUST_PROXY, () => getConnInfo(c).remote.address);
// Round-up sources (statement import, Plaid link) when ROUNDUPS_ENABLED=1; see api/routes/roundups.ts.
const roundups = await roundupsFromEnv(config.env, { chainId, db, pub, ipOf });
const app = createApp(
  { chainId, pub, db, dep, blockTimes: new BlockTimes(pub), mcpSecret: config.MCP_TOKEN_SECRET },
  { corsOrigins: corsOrigins(config.CORS_ORIGINS), eligibility: elig?.routes, roundups, ipOf, rateLimit: { perMinute: config.API_RATE_LIMIT, heavyPerMinute: config.API_HEAVY_RATE_LIMIT } },
);
const server = Bun.serve({ port: config.API_PORT, fetch: app.fetch });
console.log(`[api ${chainId}] listening on :${server.port} ${JSON.stringify(safeConfigSummary(config, keysFor("API_", "CORS_", "ROUNDUPS_", "ELIGIBILITY_", "LOG_")))}`);
