// bun run relayer   -> POST /claim, GET /health on RELAYER_PORT (default 8791)
// Env (config.ts): RELAYER_CHAIN=local|testnet|mainnet (default local), LOCAL_RPC_URL / RHC_*_RPC_URL,
// RELAYER_DEPLOYMENTS_DIR (default app/deployments), RELAYER_PRIVATE_KEY or RELAYER_KEYSTORE +
// RELAYER_KEYSTORE_PASSWORD_FILE (a Foundry keystore; the wallet pays gas; the key is never logged),
// RELAYER_TRUST_PROXY=1 to rate-limit by X-Forwarded-For (only behind your own proxy),
// RELAYER_IP_LIMIT (per minute, default 20), RELAYER_STEALTH_LIMIT (per minute, default 3),
// RELAYER_WITHDRAW_MIN_FEES ("0xasset:raw,..." minimum Hidden Vault withdraw fee per asset; unlisted assets are not
// relayed) and RELAYER_CLAIM_MIN_RAW (smallest relayed Quiet claim per token). Both are required on mainnet; blank on
// local / testnet = defaults for USDG and every Stock Token of the deployment (relayer/chain.ts relayerTables).
// POST /withdraw is enabled when the deployment has a shieldedPool; POST /swap and /settle (private sell / buy / park)
// when it also has a shieldedTrade.
import { keysFor, loadConfig, rpcUrlFor, safeConfigSummary } from "@/config";
import { readDeployment } from "@/indexer";
import { getConnInfo } from "hono/bun";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type PublicClient } from "viem";
import { loadSigner } from "@/keeper/signer";
import { relayerApp } from "@/relayer/app";
import { chainDeps, NonceManager, relayerTables, tradeDeps, withdrawDeps } from "@/relayer/chain";
import { RateLimiter } from "@/relayer/ratelimit";

const config = loadConfig();
const rpcUrl = rpcUrlFor(config, config.RELAYER_CHAIN);
// Same loader as the keeper (env key or Foundry keystore), fed the RELAYER_* variables.
const account = (() => {
  try {
    return loadSigner({ KEEPER_PRIVATE_KEY: config.RELAYER_PRIVATE_KEY, KEEPER_KEYSTORE: config.RELAYER_KEYSTORE, KEEPER_KEYSTORE_PASSWORD_FILE: config.RELAYER_KEYSTORE_PASSWORD_FILE });
  } catch (err) {
    throw new Error(String((err as Error).message).replaceAll("KEEPER_", "RELAYER_"));
  }
})();
const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
const dep = readDeployment(config.RELAYER_DEPLOYMENTS_DIR, chainId);
if (!dep || typeof dep.stealthClaims !== "string") throw new Error(`deployments/${chainId}.json has no stealthClaims`);
const plynth = Object.entries(dep).filter(([k, v]) => k !== "deployer" && typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)).map(([, v]) => v as string);
for (const s of Object.values(dep.stocks ?? {})) plynth.push(s.token);

const trustProxy = config.RELAYER_TRUST_PROXY;
const tables = relayerTables(config, config.RELAYER_CHAIN, dep as { usdg?: unknown; stocks?: Record<string, { token: string }> });
// One nonce source for claims and withdraws: concurrent requests never sign the same nonce.
const nonces = new NonceManager(() => pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
const app = relayerApp({
  ...chainDeps({ pub, wallet, account, chain, stealthClaims: getAddress(dep.stealthClaims), plynth, nonces }),
  claimMin: tables.claimMin,
  ipOf: (c) => (trustProxy ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown") : (getConnInfo(c).remote.address ?? "unknown")),
  ipLimiter: new RateLimiter(config.RELAYER_IP_LIMIT, 60_000),
  stealthLimiter: new RateLimiter(config.RELAYER_STEALTH_LIMIT, 60_000),
  withdraw:
    typeof dep.shieldedPool === "string"
      ? withdrawDeps({ pub, wallet, account, chain, pool: getAddress(dep.shieldedPool), minFee: tables.minFee, nonces })
      : undefined,
  // Private sell / buy / park (POST /swap, /settle) when the deployment has a ShieldedTrade.
  trade:
    typeof dep.shieldedTrade === "string" && typeof dep.shieldedPool === "string"
      ? tradeDeps({ pub, wallet, account, chain, trade: getAddress(dep.shieldedTrade), pool: getAddress(dep.shieldedPool), minFee: tables.minFee, nonces })
      : undefined,
  log: (m) => console.log(`[relayer ${chainId}] ${m}`),
  corsOrigins: config.CORS_ORIGINS
    ? config.CORS_ORIGINS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)
    : undefined,
});
const server = Bun.serve({ port: config.RELAYER_PORT, fetch: app.fetch });
console.log(`[relayer ${chainId}] ${account.address} on :${server.port} ${JSON.stringify(safeConfigSummary(config, keysFor("RELAYER_", "LOG_")))}`);
