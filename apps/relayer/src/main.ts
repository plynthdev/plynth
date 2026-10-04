// bun run relayer   -> POST /claim, GET /health on RELAYER_PORT (default 8789)
// Env: RELAYER_CHAIN=local|testnet|mainnet (default local), LOCAL_RPC_URL / RHC_*_RPC_URL,
// RELAYER_DEPLOYMENTS_DIR (default ./deployments), RELAYER_PRIVATE_KEY or RELAYER_KEYSTORE +
// RELAYER_KEYSTORE_PASSWORD_FILE (a Foundry keystore; the wallet pays gas; the key is never logged),
// RELAYER_TRUST_PROXY=1 to rate-limit by X-Forwarded-For (only behind your own proxy),
// RELAYER_IP_LIMIT (per minute, default 20), RELAYER_STEALTH_LIMIT (per minute, default 3).
import { readDeployment } from "@plynth/indexer";
import { getConnInfo } from "hono/bun";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadSigner } from "@plynth/keeper/src/signer";
import { relayerApp } from "./app";
import { chainDeps } from "./chain";
import { RateLimiter } from "./ratelimit";

const chainName = process.env.RELAYER_CHAIN || "local";
const rpcUrl =
  chainName === "mainnet"
    ? process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : chainName === "testnet"
      ? process.env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com"
      : process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
// Same loader as the keeper (env key or Foundry keystore), fed the RELAYER_* variables.
const account = (() => {
  try {
    return loadSigner({ KEEPER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY, KEEPER_KEYSTORE: process.env.RELAYER_KEYSTORE, KEEPER_KEYSTORE_PASSWORD_FILE: process.env.RELAYER_KEYSTORE_PASSWORD_FILE });
  } catch (err) {
    throw new Error(String((err as Error).message).replaceAll("KEEPER_", "RELAYER_"));
  }
})();
const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
const dep = readDeployment(process.env.RELAYER_DEPLOYMENTS_DIR || join(import.meta.dir, "..", "..", "..", "deployments"), chainId);
if (!dep || typeof dep.stealthClaims !== "string") throw new Error(`deployments/${chainId}.json has no stealthClaims`);
const plynth = Object.entries(dep).filter(([k, v]) => k !== "deployer" && typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)).map(([, v]) => v as string);
for (const s of Object.values(dep.stocks ?? {})) plynth.push(s.token);

const trustProxy = process.env.RELAYER_TRUST_PROXY === "1";
const app = relayerApp({
  ...chainDeps({ pub, wallet, account, chain, stealthClaims: getAddress(dep.stealthClaims), plynth }),
  ipOf: (c) => (trustProxy ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown") : (getConnInfo(c).remote.address ?? "unknown")),
  ipLimiter: new RateLimiter(Number(process.env.RELAYER_IP_LIMIT || 20), 60_000),
  stealthLimiter: new RateLimiter(Number(process.env.RELAYER_STEALTH_LIMIT || 3), 60_000),
  log: (m) => console.log(`[relayer ${chainId}] ${m}`),
});
const server = Bun.serve({ port: Number(process.env.RELAYER_PORT ?? 8789), fetch: app.fetch });
console.log(`[relayer ${chainId}] ${account.address} on :${server.port}`);
