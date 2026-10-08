// Shared constants and pure helpers for the Robinhood Chain MAINNET (4663) closed beta (app/scripts/mainnet).
// Nothing here deploys or sends: the deploy is a separate, manual forge command (MainnetBeta.s.sol) run after an
// explicit go, and the bots are funded by hand. These scripts only turn the deploy output into what the services
// read and start the services, refusing anything that is not chain 4663.
//
// Keys: Foundry keystores ~/.foundry/keystores/plynth-main-<role>, password files ~/.plynth-mainnet/<role>.password.
// The env files name those PATHS only; each service unlocks its own keystore.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";

export const APP = join(import.meta.dir, "..", "..");
export const ROOT = join(APP, "..");

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const FORK_CHAIN_ID = 31337;
export const RPC = process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const DB_NAME = process.env.MAINNET_DB_NAME || "plynth_mainnet";
/** Orbit NodeInterface (virtual contract): gasEstimateComponents gives the L1 data part of a transaction. */
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as Address;

/** Gitignored working directory: env files, logs, pid files, secrets. */
export const MAINNET_DIR = process.env.MAINNET_DIR || join(APP, ".mainnet");
export const PATHS = {
  deployments: join(APP, "deployments"),
  /** MainnetBeta.s.sol's raw output (BETA_OUT default). */
  raw: join(APP, "deployments", `${MAINNET_CHAIN_ID}-beta.json`),
  deployment: join(APP, "deployments", `${MAINNET_CHAIN_ID}.json`),
  treasuryDeployment: join(APP, "deployments", `${MAINNET_CHAIN_ID}-treasury.json`),
  broadcast: join(ROOT, "contracts", "broadcast", "MainnetBeta.s.sol", String(MAINNET_CHAIN_ID), "run-latest.json"),
  env: join(MAINNET_DIR, "env"),
  logs: join(MAINNET_DIR, "logs"),
  pids: join(MAINNET_DIR, "pids"),
  secrets: join(MAINNET_DIR, "secrets.json"),
};

export const KEYSTORE_DIR = process.env.MAINNET_KEYSTORE_DIR || join(homedir(), ".foundry", "keystores");
export const PASSWORD_DIR = process.env.MAINNET_PASSWORD_DIR || join(homedir(), ".plynth-mainnet");

/** Mainnet roles with a keystore on this machine (the owner is a MetaMask / Safe account, never on a server). */
export const BOTS = ["deployer", "keeper", "relayer", "controller", "attester", "cashdesk", "equitydesk"] as const;
export type Bot = (typeof BOTS)[number];
export const keystoreName = (b: Bot) => `plynth-main-${b}`;
export const keystorePath = (b: Bot) => join(KEYSTORE_DIR, keystoreName(b));
export const passwordFile = (b: Bot) => join(PASSWORD_DIR, `${b}.password`);
/** Signer variables for a service: <PREFIX>_KEYSTORE + <PREFIX>_KEYSTORE_PASSWORD_FILE (paths, never a key). */
export const keystoreVars = (prefix: string, b: Bot) => ({ [`${prefix}_KEYSTORE`]: keystorePath(b), [`${prefix}_KEYSTORE_PASSWORD_FILE`]: passwordFile(b) });

/** The keeper and indexer read proofs this many blocks behind the head on mainnet (todo 47: >= 2). */
export const MIN_CONFIRMATIONS = 2;

export class WrongChainError extends Error {}

/** Throws unless `id` is Robinhood Chain mainnet. */
export function assertMainnetChainId(id: number | bigint | string, where = RPC): void {
  const n = typeof id === "string" ? Number(BigInt(id)) : Number(id);
  if (n !== MAINNET_CHAIN_ID) throw new WrongChainError(`${where} answered chain id ${n}, expected Robinhood Chain mainnet ${MAINNET_CHAIN_ID}: refusing`);
}

/** Asks the RPC directly and throws unless it is chain 4663. */
export async function assertMainnet(rpc = RPC): Promise<void> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (!body.result) throw new WrongChainError(`${rpc} did not answer eth_chainId: ${JSON.stringify(body.error ?? body)}`);
  assertMainnetChainId(body.result, rpc);
}

/** Formats wei as ETH with up to 6 decimals ("0.001234"). */
export function fmtEth(wei: bigint, digits = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = v.toString().padStart(19, "0");
  const frac = s.slice(-18).slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -18)}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------- cost model (unit-tested)

export type CostTx = { gasUsed: bigint; l1Gas: bigint };

/**
 * Orbit charges (L2 gas used + L1 data gas expressed in L2 gas) x the L2 base fee. The L1 part comes from
 * NodeInterface.gasEstimateComponents, already converted to L2 gas at the base fee it reports.
 */
export function txCostWei(t: CostTx, baseFee: bigint): bigint {
  return (t.gasUsed + t.l1Gas) * baseFee;
}

/** Sum of `txs` at `baseFee`, plus `marginBps` (5000 = +50%), rounded up. */
export function withMargin(wei: bigint, marginBps: bigint): bigint {
  return (wei * (10_000n + marginBps) + 9_999n) / 10_000n;
}

export type BotDay = { role: string; txs: number; l2Gas: bigint; l1Gas: bigint };

/**
 * 30-day bot gas: each role's gas per crowd window measured on the fork (one window = one day on mainnet: the
 * 24h crowd window) x `days`. `windows` is how many crowd windows the fork run executed.
 */
export function botBudget(rows: BotDay[], windows: number, days: number, baseFee: bigint): { role: string; perDayWei: bigint; totalWei: bigint; txsPerDay: number }[] {
  if (windows <= 0) throw new Error("windows must be > 0");
  return rows.map((r) => {
    const perDayGas = (r.l2Gas + r.l1Gas + BigInt(windows) - 1n) / BigInt(windows);
    const perDayWei = perDayGas * baseFee;
    return { role: r.role, perDayWei, totalWei: perDayWei * BigInt(days), txsPerDay: r.txs / windows };
  });
}

// ---------------------------------------------------------------- deployment files

export type MainnetDeployment = Record<string, unknown> & {
  chainId: number;
  deployBlock: number;
  owner: Address;
  acceptOwnership: Address[];
  stocks: Record<string, { token: Address; feed: Address; poolId: Hex }>;
  perpMarkets: Record<string, Address>;
};

/**
 * MainnetBeta.s.sol's raw output -> what the services read: deployBlock / treasuryFactoryBlock = the L2 block of
 * the first deploy transaction (forge writes the parent-chain block on Orbit), stocks and perpMarkets as objects,
 * checksummed addresses, and the <chainid>-treasury.json split. Refuses a file for any chain but 4663.
 */
export function normalizeDeployment(raw: Record<string, unknown>, deployBlock: number): { main: MainnetDeployment; treasury: Record<string, unknown> } {
  const obj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  const main: Record<string, unknown> = { ...raw, stocks: obj(raw.stocks), perpMarkets: obj(raw.perpMarkets), deployBlock, treasuryFactoryBlock: deployBlock };
  for (const [k, v] of Object.entries(main)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) main[k] = getAddress(v);
  if (Array.isArray(main.acceptOwnership)) main.acceptOwnership = (main.acceptOwnership as string[]).map((a) => getAddress(a));
  if (Number(main.chainId) !== MAINNET_CHAIN_ID) throw new WrongChainError(`deployment file is for chain ${main.chainId}, not ${MAINNET_CHAIN_ID}`);
  if (main.fork === true) throw new WrongChainError("deployment file comes from a fork-mode run, not the mainnet deploy");
  const treasury = {
    chainId: main.chainId,
    treasuryFactory: main.treasuryFactory,
    treasuryFactoryBlock: deployBlock,
    policyGuard: main.policyGuard,
    receipts: main.receipts,
    templateRegistry: main.templateRegistry,
  };
  return { main: main as MainnetDeployment, treasury };
}

export function readDeployment(): MainnetDeployment | undefined {
  if (!existsSync(PATHS.deployment)) return undefined;
  return JSON.parse(readFileSync(PATHS.deployment, "utf8")) as MainnetDeployment;
}

/** KEY=value lines; empty values dropped. */
export function envFileText(vars: Record<string, string | number | undefined>): string {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

export function ensureDirs() {
  for (const d of [MAINNET_DIR, PATHS.env, PATHS.logs, PATHS.pids]) mkdirSync(d, { recursive: true });
}

/** Per-deployment secrets (keeper sealing key, MCP token secret). Random, gitignored, never printed. */
export function secrets(): { keeperSecretKey: Hex; mcpTokenSecret: string } {
  if (existsSync(PATHS.secrets)) return JSON.parse(readFileSync(PATHS.secrets, "utf8"));
  const hex = (n: number) => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex")}` as Hex;
  const s = { keeperSecretKey: hex(32), mcpTokenSecret: hex(32).slice(2) };
  mkdirSync(MAINNET_DIR, { recursive: true });
  writeFileSync(PATHS.secrets, JSON.stringify(s), { mode: 0o600 });
  return s;
}

export function log(m: string) {
  console.log(`[mainnet ${new Date().toISOString().slice(11, 19)}] ${m}`);
}
