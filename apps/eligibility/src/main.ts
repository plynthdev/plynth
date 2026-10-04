// bun run eligibility -> POST /eligibility/check on ELIGIBILITY_PORT (default 8790). See src/config.ts for env.
// ELIGIBILITY_CHAIN=local|testnet|mainnet picks the RPC (for ERC-1271 wallet signatures and the optional oracle).
import { connect, databaseUrl } from "@plynth/db";
import { Hono } from "hono";
import { createPublicClient, http, type PublicClient } from "viem";
import { eligibilityFromEnv } from "./config";

const chainName = process.env.ELIGIBILITY_CHAIN || "local";
const rpcUrl =
  chainName === "mainnet"
    ? process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : chainName === "testnet"
      ? process.env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com"
      : process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const pub = createPublicClient({ transport: http(rpcUrl, { retryCount: 3, retryDelay: 500 }) }) as PublicClient;
const chainId = await pub.getChainId();
const { db } = connect(databaseUrl());
const e = eligibilityFromEnv(process.env, { chainId, pub, db });
if (!e) throw new Error("set ELIGIBILITY_REGISTRY (and the attester key) to run the eligibility service");
const app = new Hono();
app.route("/eligibility", e.routes);
app.get("/health", (c) => c.json({ ok: true, attester: e.attester }));
const server = Bun.serve({ port: Number(process.env.ELIGIBILITY_PORT ?? 8790), fetch: app.fetch });
console.log(`[eligibility ${chainId}] listening on :${server.port}, attester ${e.attester}`);
