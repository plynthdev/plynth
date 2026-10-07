// Shared constants and helpers for the persistent mainnet fork (app/scripts/fork). Everything here talks to the
// local anvil fork only (chain id 31337); the real chain is read once, by anvil, through --fork-url.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

export const APP = join(import.meta.dir, "..", "..");
export const ROOT = join(APP, "..");
/** PORT_OFFSET: run a second fork next to services already on the default ports (e.g. the testnet stack on
 *  8787-8799): anvil 8545 + offset, rpc-cache 8600 + offset, every service port + offset, database plynth_fork2,
 *  working directory app/.fork-<offset>. 0 (default) = the usual ports, plynth_fork and app/.fork. */
export const PORT_OFFSET = (() => {
  const n = Number(process.env.PORT_OFFSET || 0);
  if (!Number.isInteger(n) || n < 0 || n > 50_000) throw new Error(`PORT_OFFSET must be an integer 0..50000, got ${process.env.PORT_OFFSET}`);
  return n;
})();

/** Gitignored working directory of the fork: anvil state, deployment files, logs, pid files, secrets. */
export const FORK_DIR = process.env.FORK_DIR || join(APP, PORT_OFFSET ? `.fork-${PORT_OFFSET}` : ".fork");
export const PATHS = {
  state: join(FORK_DIR, "state.json"),
  forkBlock: join(FORK_DIR, "fork-block"),
  deployments: join(FORK_DIR, "deployments"),
  env: join(FORK_DIR, "env"),
  logs: join(FORK_DIR, "logs"),
  pids: join(FORK_DIR, "pids"),
  secrets: join(FORK_DIR, "secrets.json"),
  treasury: join(FORK_DIR, "treasury"),
  results: join(FORK_DIR, "results.json"),
  exercised: join(FORK_DIR, "exercised"),
  /** Written by ForkMainnet.s.sol (forge may only write under app/deployments). */
  forgeOut: join(APP, "deployments", "fork.json"),
};

export const FORK_CHAIN_ID = 31337;
export const RPC = process.env.FORK_RPC_URL || `http://127.0.0.1:${8545 + PORT_OFFSET}`;
export const DB_NAME = PORT_OFFSET ? "plynth_fork2" : "plynth_fork";

/** Ports: the .env.example defaults, one per service, + PORT_OFFSET. */
const BASE_PORTS = {
  anvil: 8545,
  indexer: 8787,
  keeper: 8788,
  api: 8789,
  eligibility: 8790,
  relayer: 8791,
  mcp: 8792,
  "treasury-desks": 8793,
  "treasury-close": 8794,
  "treasury-risk": 8795,
  "treasury-receipts": 8796,
  "treasury-marks": 8797,
  "treasury-reconciler": 8798,
  "treasury-webhooks": 8799,
} as const;
export const PORTS = Object.fromEntries(Object.entries(BASE_PORTS).map(([k, v]) => [k, v + PORT_OFFSET])) as { [K in keyof typeof BASE_PORTS]: number };

/** Anvil's well-known public dev mnemonic: every key derived from it is a public test key. */
export const DEV_MNEMONIC = "test test test test test test test test test test test junk"; // test-key (anvil default mnemonic)

/** Who is who on the fork (indices into the dev mnemonic). 0-9 are anvil's ten default accounts. */
export const ROLE = {
  deployer: 0, // owner of every contract, board of the fork treasuries
  keeper: 1,
  attester: 2, // eligibility attester
  controller: 3, // treasury policy controller (close, receipts, mirror)
  cash: 4,
  equity: 5,
  hedge: 6,
  basis: 7,
  committee: 8, // template review + insurance committee
  relayer: 9,
} as const;
/** Exercise actors beyond the ten defaults (savers, wallets, LPs, traders): indices 10..39. */
export const EXTRA_ACCOUNTS = 30;

export function devAccount(index: number): HDAccount {
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
}
export function devKey(index: number): Hex {
  const k = devAccount(index).getHdKey().privateKey;
  if (!k) throw new Error(`no key for dev account ${index}`);
  return `0x${Buffer.from(k).toString("hex")}` as Hex;
}
export const role = (r: keyof typeof ROLE) => devAccount(ROLE[r]);
export const allAccounts = () => Array.from({ length: 10 + EXTRA_ACCOUNTS }, (_, i) => devAccount(i));

export const forkChain = (rpc = RPC) =>
  defineChain({ id: FORK_CHAIN_ID, name: "Plynth fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

export function clients(rpc = RPC) {
  const chain = forkChain(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }), pollingInterval: 100 }) as PublicClient;
  const wallet = (acct: LocalAccount) => createWalletClient({ chain, transport: http(rpc, { timeout: 60_000 }), account: acct, pollingInterval: 100 });
  const rpcCall = <T = unknown>(method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never }) as Promise<T>;
  return { chain, pub, wallet, rpc: rpcCall };
}

export function ensureDirs() {
  for (const d of [FORK_DIR, PATHS.deployments, PATHS.env, PATHS.logs, PATHS.pids, PATHS.treasury]) mkdirSync(d, { recursive: true });
}

/** Per-fork secrets (keeper sealing key, MCP token secret). Random, gitignored, never printed. */
export function secrets(): { keeperSecretKey: Hex; mcpTokenSecret: string } {
  if (existsSync(PATHS.secrets)) return JSON.parse(readFileSync(PATHS.secrets, "utf8"));
  const hex = (n: number) => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex")}` as Hex;
  const s = { keeperSecretKey: hex(32), mcpTokenSecret: hex(32).slice(2) };
  writeFileSync(PATHS.secrets, JSON.stringify(s), { mode: 0o600 });
  return s;
}

export type ForkDeployment = Record<string, unknown> & {
  chainId: number;
  deployBlock: number;
  usdg: Address;
  stocks: Record<string, { token: Address; feed: Address; poolId: Hex; fee: number; tickSpacing: number; currency0: Address; currency1: Address }>;
  perpMarkets: Record<string, Address>;
};

/** The merged deployment file (deployments/fork.json schema) once the fork is deployed. */
export function readForkDeployment(): ForkDeployment | undefined {
  const f = join(PATHS.deployments, `${FORK_CHAIN_ID}.json`);
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, "utf8")) as ForkDeployment;
}

/**
 * Splits the script's fork.json into the per-service files the services read from one deployments dir:
 * <chainid>.json (core + consumer, what the indexer, keeper, relayer and API read) and <chainid>-treasury.json
 * (factory, receipts, templates: merged by the API and the MCP server). `deployBlock` is the L2 block the deploy
 * started at, read over RPC (forge's block number on an Orbit fork can be the parent chain's).
 */
export function splitDeployment(raw: Record<string, unknown>, deployBlock: number): { main: ForkDeployment; treasury: Record<string, unknown> } {
  const stocks = typeof raw.stocks === "string" ? JSON.parse(raw.stocks) : raw.stocks;
  const perpMarkets = typeof raw.perpMarkets === "string" ? JSON.parse(raw.perpMarkets) : raw.perpMarkets;
  const main = { ...raw, stocks, perpMarkets, deployBlock, treasuryFactoryBlock: deployBlock } as unknown as ForkDeployment;
  for (const k of Object.keys(main)) {
    const v = main[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) (main as Record<string, unknown>)[k] = getAddress(v);
  }
  const treasury = {
    chainId: main.chainId,
    treasuryFactory: main.treasuryFactory,
    treasuryFactoryBlock: deployBlock,
    policyGuard: main.policyGuard,
    receipts: main.receipts,
    templateRegistry: main.templateRegistry,
  };
  return { main, treasury };
}

export function log(m: string) {
  console.log(`[fork ${new Date().toISOString().slice(11, 19)}] ${m}`);
}

/** Waits until the fork answers eth_chainId with 31337. */
export async function waitForRpc(rpc = RPC, timeoutMs = 120_000) {
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const id = await pub.getChainId();
      if (id !== FORK_CHAIN_ID) throw new Error(`chain id ${id} at ${rpc}, expected ${FORK_CHAIN_ID}: is another chain on this port?`);
      return;
    } catch (e) {
      if ((e as Error).message.includes("expected")) throw e;
      if (Date.now() > end) throw new Error(`fork did not answer at ${rpc} within ${timeoutMs / 1000}s`);
      await Bun.sleep(500);
    }
  }
}
