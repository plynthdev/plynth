// Shared constants and helpers for the Robinhood Chain TESTNET stack (app/scripts/testnet). Unlike the fork
// scripts, these send real transactions, so every one of them goes through `guardedTransport`: before any
// eth_sendRawTransaction / eth_sendTransaction the RPC must answer eth_chainId == 46630, otherwise the send is
// refused. Mainnet (4663) is refused by name. The signed transactions also carry chain id 46630 (EIP-155), so
// none of them could be replayed on mainnet either.
//
// Keys: Foundry keystores in ~/.foundry/keystores, unlocked with the password files in ~/.plynth-testnet
// (chmod 600). A key is only ever held in memory inside a viem LocalAccount; nothing here prints one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, isAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { decryptKeystore } from "@/keeper/signer";
import { PORTS } from "../fork/lib";

export { PORTS };
export const APP = join(import.meta.dir, "..", "..");
export const ROOT = join(APP, "..");

export const TESTNET_CHAIN_ID = 46630;
export const MAINNET_CHAIN_ID = 4663;
export const RPC = process.env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
export const MAINNET_RPC = process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
/** TESTNET_DB_NAME only for a dry run against an anvil fork of testnet (keeps the real run's database clean). */
export const DB_NAME = process.env.TESTNET_DB_NAME || "plynth_testnet";

/** Gitignored working directory: env files, logs, pid files, secrets, exercise state, results. */
export const TESTNET_DIR = process.env.TESTNET_DIR || join(APP, ".testnet");
export const PATHS = {
  /** The committed deployment files (testnet addresses are public). */
  deployments: join(APP, "deployments"),
  deployment: join(APP, "deployments", `${TESTNET_CHAIN_ID}.json`),
  treasuryDeployment: join(APP, "deployments", `${TESTNET_CHAIN_ID}-treasury.json`),
  env: join(TESTNET_DIR, "env"),
  logs: join(TESTNET_DIR, "logs"),
  pids: join(TESTNET_DIR, "pids"),
  secrets: join(TESTNET_DIR, "secrets.json"),
  treasury: join(TESTNET_DIR, "treasury"),
  state: join(TESTNET_DIR, "exercise-state.json"),
  results: join(TESTNET_DIR, "results.json"),
  ledger: join(TESTNET_DIR, "gas-ledger.json"),
  reports: join(TESTNET_DIR, "reports"),
};

export const KEYSTORE_DIR = process.env.TESTNET_KEYSTORE_DIR || join(homedir(), ".foundry", "keystores");
export const PASSWORD_DIR = process.env.TESTNET_PASSWORD_DIR || join(homedir(), ".plynth-testnet");

/** Who is who on testnet: role -> Foundry keystore name. */
export const WALLETS = {
  deployer: "plynth-testnet", // owner of every contract, treasury board, LP, staker, template committee
  keeper: "plynth-keeper",
  relayer: "plynth-relayer",
  controller: "plynth-controller", // treasury policy controller (close, receipts, mirror)
  attester: "plynth-attester", // eligibility attester (signs only, no gas)
  cashDesk: "plynth-desk-cash",
  equityDesk: "plynth-desk-equity",
  open: "plynth-helper-1", // Open saver, perp trader
  quiet: "plynth-helper-2", // Quiet saver
  hidden: "plynth-helper-3", // Hidden saver
  spender: "plynth-helper-4", // spending wallet linked to the Open saver
} as const;
export type Role = keyof typeof WALLETS;

/**
 * Tester wallets (MetaMask accounts for a click-through) that setup funds with a little testnet ETH and mock
 * USDG: TESTNET_TESTERS (comma-separated) or, one per line, the file `testers` next to the password files.
 * Kept out of the repository on purpose.
 */
export function testers(env: Record<string, string | undefined> = process.env, file = join(PASSWORD_DIR, "testers")): Address[] {
  const raw = env.TESTNET_TESTERS ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
  const out = new Map<string, Address>();
  for (const a of raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    if (!isAddress(a, { strict: false })) throw new Error(`tester ${a} is not an address`);
    out.set(a.toLowerCase(), getAddress(a));
  }
  return [...out.values()];
}

export const keystorePath = (name: string) => join(KEYSTORE_DIR, name);
export const passwordFile = (name: string) => join(PASSWORD_DIR, `${name}.password`);

const accounts = new Map<string, PrivateKeyAccount>();
/** Unlocks a keystore with its password file. The key stays inside the returned account. */
export function loadAccount(name: string): PrivateKeyAccount {
  const hit = accounts.get(name);
  if (hit) return hit;
  const ks = keystorePath(name);
  const pw = passwordFile(name);
  if (!existsSync(ks)) throw new Error(`no keystore ${ks}`);
  if (!existsSync(pw)) throw new Error(`no password file ${pw}`);
  const acct = privateKeyToAccount(decryptKeystore(readFileSync(ks, "utf8"), readFileSync(pw, "utf8").trim()));
  accounts.set(name, acct);
  return acct;
}
export const role = (r: Role) => loadAccount(WALLETS[r]);

// ---------------------------------------------------------------- the network guard

export class WrongChainError extends Error {}

/** Throws unless `id` is the testnet. Mainnet gets its own message: it must never be sent to. */
export function assertTestnetChainId(id: number | bigint | string, where = RPC): void {
  const n = typeof id === "string" ? Number(BigInt(id)) : Number(id);
  if (n === MAINNET_CHAIN_ID) throw new WrongChainError(`${where} is Robinhood Chain MAINNET (4663): refusing to send`);
  if (n !== TESTNET_CHAIN_ID) throw new WrongChainError(`${where} answered chain id ${n}, expected testnet ${TESTNET_CHAIN_ID}: refusing to send`);
}

type Request = (args: { method: string; params?: unknown }) => Promise<unknown>;
const SENDS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sendRawTransactionSync"]);

/**
 * Wraps an EIP-1193 request function: every send first asks the same endpoint for eth_chainId and refuses
 * anything but 46630. Reads pass through untouched.
 */
export function guardRequest(inner: Request, where = RPC): Request {
  return async (args) => {
    if (SENDS.has(args.method)) assertTestnetChainId((await inner({ method: "eth_chainId" })) as string, where);
    return inner(args);
  };
}

export const testnetChain = (rpc = RPC) =>
  defineChain({
    id: TESTNET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  });

/** A transport to `rpc` whose sends are chain-id guarded (public RPC: patient retries). */
export function guardedTransport(rpc = RPC) {
  const inner = http(rpc, { timeout: 60_000, retryCount: 6, retryDelay: 750 })({ chain: testnetChain(rpc), retryCount: 6 });
  return custom({ request: guardRequest(inner.request as Request, rpc) }, { retryCount: 0 });
}

/** Same shape as the fork's clients() so the exercise Recorder works on both. */
export function clients(rpc = RPC) {
  const chain = testnetChain(rpc);
  const transport = guardedTransport(rpc);
  const pub = createPublicClient({ chain, transport, pollingInterval: 1000 }) as PublicClient;
  const wallet = (acct: LocalAccount) => createWalletClient({ chain, transport, account: acct, pollingInterval: 1000 });
  const rpcCall = <T = unknown>(method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never }) as Promise<T>;
  return { chain, pub, wallet, rpc: rpcCall };
}

/** Asks the RPC directly (no client) and throws unless it is the testnet. */
export async function assertTestnet(rpc = RPC): Promise<void> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (!body.result) throw new WrongChainError(`${rpc} did not answer eth_chainId: ${JSON.stringify(body.error ?? body)}`);
  assertTestnetChainId(body.result, rpc);
}

// ---------------------------------------------------------------- small pure helpers (unit-tested)

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;

/** Formats wei as ETH with up to 6 decimals ("0.001234"). */
export function fmtEth(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = v.toString().padStart(19, "0");
  const frac = s.slice(-18).slice(0, 6).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -18)}${frac ? `.${frac}` : ""}`;
}

export type LedgerEntry = { at: string; what: string; from: string; to?: string | undefined; tx?: string | undefined; gasUsed?: string | undefined; feeWei: string; valueWei?: string | undefined };

/** Total fees and value moved by the ledger, per sender. */
export function ledgerTotals(entries: LedgerEntry[]): Record<string, { fees: bigint; sent: bigint; txs: number }> {
  const out: Record<string, { fees: bigint; sent: bigint; txs: number }> = {};
  for (const e of entries) {
    const t = (out[e.from] ??= { fees: 0n, sent: 0n, txs: 0 });
    t.fees += BigInt(e.feeWei);
    t.sent += BigInt(e.valueWei ?? "0");
    t.txs++;
  }
  return out;
}

export function readLedger(): LedgerEntry[] {
  return existsSync(PATHS.ledger) ? (JSON.parse(readFileSync(PATHS.ledger, "utf8")) as LedgerEntry[]) : [];
}
export function appendLedger(e: LedgerEntry) {
  const all = readLedger();
  all.push(e);
  writeFileSync(PATHS.ledger, JSON.stringify(all, null, 2));
}

/** A wallet at or above this share of its target is left alone (no dust top-ups on every up.sh). */
export const TOP_UP_AT_BPS = 8_000n;

/**
 * How much ETH a wallet needs to get back to `target`: 0 while it holds at least 80% of it, else the difference.
 * Never tops up past the target, so re-running setup does not drain the deployer.
 */
export function topUpAmount(balance: bigint, target: bigint): bigint {
  return balance * 10_000n >= target * TOP_UP_AT_BPS ? 0n : target - balance;
}

/**
 * Whether the deployer can afford `spend` and keep `floor` (0.001 ETH: the todo's minimum). `maxFeePerGas`
 * covers base-fee moves between estimate and inclusion.
 */
export function affordable(balance: bigint, spend: bigint, floor: bigint): boolean {
  return balance - spend >= floor;
}

export function ensureDirs() {
  for (const d of [TESTNET_DIR, PATHS.env, PATHS.logs, PATHS.pids, PATHS.treasury, PATHS.reports]) mkdirSync(d, { recursive: true });
}

/** Per-deployment secrets (keeper sealing key, MCP token secret). Random, gitignored, never printed. */
export function secrets(): { keeperSecretKey: Hex; mcpTokenSecret: string } {
  if (existsSync(PATHS.secrets)) return JSON.parse(readFileSync(PATHS.secrets, "utf8"));
  const hex = (n: number) => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex")}` as Hex;
  const s = { keeperSecretKey: hex(32), mcpTokenSecret: hex(32).slice(2) };
  mkdirSync(TESTNET_DIR, { recursive: true });
  writeFileSync(PATHS.secrets, JSON.stringify(s), { mode: 0o600 });
  return s;
}

export type TestnetDeployment = Record<string, unknown> & {
  chainId: number;
  deployBlock: number;
  usdg: Address;
  stocks: Record<string, { token: Address; feed: Address; poolId: Hex; fee: number; tickSpacing: number; currency0: Address; currency1: Address; underlying: string; uiMultiplier: number | string }>;
  perpMarkets: Record<string, Address>;
};

export function readDeployment(): TestnetDeployment | undefined {
  if (!existsSync(PATHS.deployment)) return undefined;
  return JSON.parse(readFileSync(PATHS.deployment, "utf8")) as TestnetDeployment;
}

export function log(m: string) {
  console.log(`[testnet ${new Date().toISOString().slice(11, 19)}] ${m}`);
}
