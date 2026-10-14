// Chain wiring. Reads the VITE_* settings once and decides whether the dashboard talks to a Plynth stack (the local
// fork from app/scripts/fork/up.sh, Robinhood Chain testnet, or the mainnet closed beta) instead of showing preview
// data. Profiles: `bun run dev` (fork, .env.local), `dev:testnet` (.env.testnet.local), `dev:mainnet` and the
// production build (VITE_CHAIN_ID=4663; see the root README's Frontend section).

export type ForkEnv = {
  VITE_FORK?: string;
  VITE_API_URL?: string;
  VITE_RPC_URL?: string;
  VITE_CHAIN_ID?: string;
  VITE_RELAYER_URL?: string;
  VITE_DEV_WALLET?: string;
  /** Network name shown to the wallet: "Plynth fork" (31337) or "Robinhood Chain Testnet" (46630 profile). */
  VITE_CHAIN_NAME?: string;
  /** Block explorer base URL; defaults per chain (none for the fork). */
  VITE_EXPLORER_URL?: string;
  /** Reown (WalletConnect) Cloud project id: public, not a secret. Empty: the EIP-6963 browser-wallet list instead. */
  VITE_WALLETCONNECT_PROJECT_ID?: string;
  DEV?: boolean;
  PROD?: boolean;
};

export type ForkConfig = {
  /** Live dashboard on; VITE_FORK=0 (or a production build without VITE_CHAIN_ID) shows the preview data. */
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
  /** Block explorer base URL without a trailing slash, "" when there is none (the local fork). */
  explorerUrl: string;
  /** VITE_DEV_WALLET=1: the anvil dev-key connector may be offered (still only on a localhost page of 31337). */
  devWalletFlag: boolean;
  /** Reown project id (32 hex) when set and well formed, "" otherwise (wallet.ts then uses the injected-wallet list). */
  walletConnectProjectId: string;
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
/** Robinhood Chain mainnet (`vite dev --mode mainnet`, and the production build): the closed beta, real funds. */
export const MAINNET_CHAIN_ID = 4663;

/** Public defaults per Robinhood Chain network (same values as viem/chains robinhood and robinhoodTestnet). */
export const CHAINS: Record<number, { name: string; rpcUrl: string; explorerUrl: string }> = {
  [TESTNET_CHAIN_ID]: {
    name: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
  [MAINNET_CHAIN_ID]: {
    name: "Robinhood Chain",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
};

/** Paths the Vite dev server proxies to the API and the relayer (vite.config.ts), so no CORS setup is needed. */
export const PROXY = {
  api: "/__fork/api",
  relayer: "/__fork/relayer",
  deployment: "/__fork/deployment.json",
} as const;

const strip = (u: string) => u.replace(/\/+$/, "");

/** A Reown Cloud project id is 32 hex characters; anything else (a placeholder, a typo) counts as unset. */
export function walletConnectProjectId(raw: string | undefined): string {
  const v = raw?.trim() ?? "";
  return /^[0-9a-f]{32}$/i.test(v) ? v : "";
}

export function readForkConfig(env: ForkEnv): ForkConfig {
  const chainId = env.VITE_CHAIN_ID ? Number(env.VITE_CHAIN_ID) : DEFAULTS.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0)
    throw new Error(`VITE_CHAIN_ID must be a positive integer (got ${env.VITE_CHAIN_ID})`);
  const known = CHAINS[chainId];
  const apiUrl = strip(env.VITE_API_URL || DEFAULTS.apiUrl);
  const relayerUrl = strip(env.VITE_RELAYER_URL || DEFAULTS.relayerUrl);
  const rpcUrl = strip(env.VITE_RPC_URL || known?.rpcUrl || DEFAULTS.rpcUrl);
  return {
    // A production build with no chain configured (e.g. a host with no env set) keeps the preview dashboard
    // instead of pointing visitors at 127.0.0.1.
    enabled: env.VITE_FORK !== "0" && !(env.PROD && !env.VITE_CHAIN_ID),
    apiUrl,
    relayerUrl,
    rpcUrl,
    chainId,
    chainName: env.VITE_CHAIN_NAME?.trim() || known?.name || DEFAULTS.chainName,
    explorerUrl: strip(env.VITE_EXPLORER_URL?.trim() || known?.explorerUrl || ""),
    apiBase: env.DEV ? PROXY.api : apiUrl,
    relayerBase: env.DEV ? PROXY.relayer : relayerUrl,
    devWalletFlag: env.VITE_DEV_WALLET === "1",
    walletConnectProjectId: walletConnectProjectId(env.VITE_WALLETCONNECT_PROJECT_ID),
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
    PROD: Boolean(import.meta.env.PROD),
  }));
}
