// bun run eligibility -> POST /eligibility/check on ELIGIBILITY_PORT (default 8790). Env: config.ts (ELIGIBILITY_*),
// wired in eligibility/setup.ts.
// ELIGIBILITY_CHAIN=local|testnet|mainnet picks the RPC (for ERC-1271 wallet signatures and the optional oracle).
import { keysFor, loadConfig, rpcUrlFor, safeConfigSummary } from "@/config";
import { connect, databaseUrl } from "@/db";
import { Hono } from "hono";
import { createPublicClient, http, type PublicClient } from "viem";
import { eligibilityFromEnv } from "@/eligibility/setup";

const config = loadConfig();
const rpcUrl = rpcUrlFor(config, config.ELIGIBILITY_CHAIN);
const pub = createPublicClient({ transport: http(rpcUrl, { retryCount: 3, retryDelay: 500 }) }) as PublicClient;
const chainId = await pub.getChainId();
const { db } = connect(databaseUrl());
const e = eligibilityFromEnv(config.env, { chainId, pub, db });
if (!e) throw new Error("set ELIGIBILITY_REGISTRY (and the attester key) to run the eligibility service");
const app = new Hono();
app.route("/eligibility", e.routes);
app.get("/health", (c) => c.json({ ok: true, attester: e.attester }));
const server = Bun.serve({ port: config.ELIGIBILITY_PORT, fetch: app.fetch });
console.log(`[eligibility ${chainId}] listening on :${server.port}, attester ${e.attester} ${JSON.stringify(safeConfigSummary(config, keysFor("ELIGIBILITY_", "LOG_")))}`);
