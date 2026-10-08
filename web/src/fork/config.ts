// Local-fork wiring (branch local-fork-testing only). Reads the VITE_* settings once and decides whether the
// dashboard talks to the local fork stack (backend/app/scripts/fork/up.sh) instead of showing preview data.

export type ForkEnv = {
  VITE_FORK?: string;
  VITE_API_URL?: string;
  VITE_RPC_URL?: string;
  VITE_CHAIN_ID?: string;
  VITE_RELAYER_URL?: string;
  VITE_DEV_WALLET?: string;
  /** Network name shown to the wallet: "Plynth fork" (31337) or "Robinhood Chain Testnet" (46630 profile). */
  VITE_CHAIN_NAME?: string;
  DEV?: boolean;
};

export type ForkConfig = {
  /** Live dashboard on; VITE_FORK=0 brings the preview data back. */
  enabled: boolean;
  /** Where the browser sends API calls: the dev-server proxy path in `vite dev`, the URL itself otherwise. */
  apiBase: string;
  relayerBase: string;
  /** The real targets (what the dev proxy forwards to). */
  apiUrl: string;
  relayerUrl: string;
  rpcUrl: string;
  chainId: number;
  chainName: string;
  /** VITE_DEV_WALLET=1: the anvil dev-key connector may be offered (still only on a localhost page). */
  devWalletFlag: boolean;
};

export const DEFAULTS = {
  apiUrl: "http://127.0.0.1:8789",
  rpcUrl: "http://127.0.0.1:8545",
  relayerUrl: "http://127.0.0.1:8791",
  chainId: 31337,
  chainName: "Plynth fork",
} as const;

/** Robinhood Chain testnet (the `vite dev --mode testnet` profile, .env.testnet.local). */
export const TESTNET_CHAIN_ID = 46630;
/** Robinhood Chain mainnet (the `vite dev --mode mainnet` profile, .env.mainnet.local): the closed beta, real funds. */
export const MAINNET_CHAIN_ID = 4663;

/** Paths the Vite dev server proxies to the API and the relayer (vite.config.ts), so no CORS setup is needed. */
export const PROXY = {
  api: "/__fork/api",
  relayer: "/__fork/relayer",
  deployment: "/__fork/deployment.json",
} as const;

const strip = (u: string) => u.replace(/\/+$/, "");

export function readForkConfig(env: ForkEnv): ForkConfig {
  const apiUrl = strip(env.VITE_API_URL || DEFAULTS.apiUrl);
  const relayerUrl = strip(env.VITE_RELAYER_URL || DEFAULTS.relayerUrl);
  const rpcUrl = strip(env.VITE_RPC_URL || DEFAULTS.rpcUrl);
  const chainId = env.VITE_CHAIN_ID ? Number(env.VITE_CHAIN_ID) : DEFAULTS.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0)
    throw new Error(`VITE_CHAIN_ID must be a positive integer (got ${env.VITE_CHAIN_ID})`);
  return {
    enabled: env.VITE_FORK !== "0",
    apiUrl,
    relayerUrl,
    rpcUrl,
    chainId,
    chainName:
      env.VITE_CHAIN_NAME?.trim() ||
      (chainId === TESTNET_CHAIN_ID
        ? "Robinhood Chain Testnet"
        : chainId === MAINNET_CHAIN_ID
          ? "Robinhood Chain"
          : DEFAULTS.chainName),
    apiBase: env.DEV ? PROXY.api : apiUrl,
    relayerBase: env.DEV ? PROXY.relayer : relayerUrl,
    devWalletFlag: env.VITE_DEV_WALLET === "1",
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True only for a page served from this machine. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * The dev wallet signs with a PUBLIC anvil key. It is offered only when both hold: VITE_DEV_WALLET=1 and the page
 * is on localhost, and the chain is the local fork (31337). A build served anywhere else never shows it.
 */
export function devWalletAllowed(
  cfg: Pick<ForkConfig, "devWalletFlag" | "chainId">,
  hostname: string,
): boolean {
  return cfg.devWalletFlag && cfg.chainId === DEFAULTS.chainId && isLocalHost(hostname);
}

let cached: ForkConfig | undefined;
export function forkConfig(): ForkConfig {
  return (cached ??= readForkConfig({
    ...(import.meta.env as unknown as ForkEnv),
    DEV: Boolean(import.meta.env.DEV),
  }));
}
