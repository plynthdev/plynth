// Every environment variable the services read, validated once at startup. Each process calls loadConfig() in its
// bin/ entry; library code that needs one value (the database URL, an RPC URL) uses configValue(name). Nothing
// else reads process.env. Blank values count as unset, so `.env.example` can list every variable with no value.
import { join } from "node:path";
import { z } from "zod";

export type ChainName = "local" | "testnet" | "mainnet";

/** Default ports: one per service, no clashes, so everything can run on one host. */
export const DEFAULT_PORTS = {
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

/** app/deployments: written by the forge deploy scripts, gitignored. */
export const DEFAULT_DEPLOYMENTS_DIR = join(import.meta.dir, "..", "deployments");
export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/plynth_dev";
export const PUBLIC_RPC = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com",
  local: "http://127.0.0.1:8545",
} as const;

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const str = (d: string) => z.preprocess(blank, z.string().trim().default(d));
const opt = z.preprocess(blank, z.string().trim().optional());
const url = (d: string) => z.preprocess(blank, z.url().default(d));
const optUrl = z.preprocess(blank, z.url().optional());
const int = (d: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(d));
const optInt = (min = 0) => z.preprocess(blank, z.coerce.number().int().min(min).optional());
const port = (d: number) => int(d, 0, 65535);
const flagDefault = (d: "0" | "1") => z.preprocess(blank, z.enum(["0", "1"]).default(d).transform((v) => v === "1"));
const flag = flagDefault("0");
const chain = z.preprocess(blank, z.enum(["local", "testnet", "mainnet"]).default("local"));
const address = z.preprocess(blank, z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address").optional());
const privateKey = z.preprocess(blank, z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 32 bytes of hex").optional());
const list = z.preprocess(blank, z.string().default("").transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)));
const blockNumber = z.preprocess(blank, z.string().regex(/^\d+$/, "must be a block number").optional());

/** A desk-style signer: <PREFIX>_KEY, or <PREFIX>_KEYSTORE + _KEYSTORE_PASSWORD or _KEYSTORE_PASSWORD_FILE. */
const signer = <P extends string>(p: P) =>
  ({
    [`${p}_KEY`]: privateKey,
    [`${p}_KEYSTORE`]: opt,
    [`${p}_KEYSTORE_PASSWORD`]: opt,
    [`${p}_KEYSTORE_PASSWORD_FILE`]: opt,
  }) as Record<`${P}_KEY` | `${P}_KEYSTORE` | `${P}_KEYSTORE_PASSWORD` | `${P}_KEYSTORE_PASSWORD_FILE`, typeof opt>;

const schema = z.object({
  // shared
  DATABASE_URL: str(DEFAULT_DATABASE_URL),
  LOCAL_RPC_URL: url(PUBLIC_RPC.local),
  RHC_MAINNET_RPC_URL: url(PUBLIC_RPC.mainnet),
  RHC_TESTNET_RPC_URL: url(PUBLIC_RPC.testnet),
  LOG_LEVEL: z.preprocess(blank, z.enum(["debug", "info", "warn", "error", "silent"]).default("info")),
  PLYNTH_TEST_DB_PREFIX: str("plynth_test_"),

  // indexer
  INDEXER_CHAIN: chain,
  INDEXER_PORT: port(DEFAULT_PORTS.indexer),
  INDEXER_POLL_MS: int(2000, 1),
  INDEXER_CONFIRMATIONS: optInt(),
  INDEXER_DEPLOYMENTS_DIR: str(DEFAULT_DEPLOYMENTS_DIR),
  INDEXER_FROM_BLOCK: blockNumber,
  INDEXER_WALLETS: list,
  INDEXER_STREAMS_FILE: opt,

  // keeper
  KEEPER_CHAIN: chain,
  KEEPER_PORT: port(DEFAULT_PORTS.keeper),
  KEEPER_INTERVAL_MS: int(30_000, 1),
  KEEPER_DEPLOYMENTS_DIR: str(DEFAULT_DEPLOYMENTS_DIR),
  KEEPER_SECRET_KEY: opt,
  KEEPER_PRIVATE_KEY: privateKey,
  KEEPER_KEYSTORE: opt,
  KEEPER_KEYSTORE_PASSWORD_FILE: opt,
  KEEPER_LOOKAHEAD: int(2, 1),
  KEEPER_CONFIRMATIONS: optInt(),
  KEEPER_JOBS: list,
  KEEPER_MAX_ACCRUALS_PER_PASS: int(200, 1),
  KEEPER_MAX_ACCRUALS_PER_USER_WEEK: int(100, 1),
  KEEPER_PERP_POKE_AGE_S: int(3600, 60),
  SPLIT_PARTS: int(2, 1, 3),
  // keeper job refresh-mock-feeds (testnet kit deployments only)
  KEEPER_MOCK_FEED_INTERVAL_S: int(600, 1),
  KEEPER_MOCK_FEED_KEEP_ALIVE: flagDefault("1"),
  KEEPER_MOCK_FEED_REAL_STALE_S: int(86_400, 1),
  KEEPER_MOCK_FEED_ALIGN_BPS: int(50, 0, 10_000),

  // relayer
  RELAYER_CHAIN: chain,
  RELAYER_PORT: port(DEFAULT_PORTS.relayer),
  RELAYER_DEPLOYMENTS_DIR: str(DEFAULT_DEPLOYMENTS_DIR),
  RELAYER_PRIVATE_KEY: privateKey,
  RELAYER_KEYSTORE: opt,
  RELAYER_KEYSTORE_PASSWORD_FILE: opt,
  RELAYER_TRUST_PROXY: flag,
  RELAYER_IP_LIMIT: int(20, 1),
  RELAYER_STEALTH_LIMIT: int(3, 1),
  RELAYER_WITHDRAW_MIN_FEES: opt,
  RELAYER_CLAIM_MIN_RAW: opt,

  // api (+ the optional eligibility and round-up routes it mounts)
  API_CHAIN: chain,
  API_PORT: port(DEFAULT_PORTS.api),
  API_TRUST_PROXY: flag,
  API_RATE_LIMIT: int(600, 1),
  API_HEAVY_RATE_LIMIT: int(30, 1),
  API_DEPLOYMENTS_DIR: str(DEFAULT_DEPLOYMENTS_DIR),
  CORS_ORIGINS: opt,
  ROUNDUPS_ENABLED: flag,
  // Webhooks to loopback / private hosts (tests and local development only; refused on mainnet).
  WEBHOOK_ALLOW_PRIVATE: flag,
  ROUNDUPS_MAX_ROWS_PER_WEEK: int(2000, 1),
  ROUNDUPS_IMPORT_IP_LIMIT: int(30, 1),
  ROUNDUPS_IMPORT_USER_LIMIT: int(10, 1),
  PLAID_ENV: z.preprocess(blank, z.enum(["sandbox", "production"]).default("sandbox")),
  PLAID_CLIENT_ID: opt,
  PLAID_SECRET: opt,
  PLAID_COUNTRY_CODES: str("US"),

  // eligibility
  ELIGIBILITY_CHAIN: chain,
  ELIGIBILITY_PORT: port(DEFAULT_PORTS.eligibility),
  ELIGIBILITY_REGISTRY: address,
  ELIGIBILITY_ATTESTER_KEY: privateKey,
  ELIGIBILITY_KEYSTORE: opt,
  ELIGIBILITY_KEYSTORE_PASSWORD_FILE: opt,
  ELIGIBILITY_IP_DB: str("data/dbip-country-lite.mmdb"),
  ELIGIBILITY_SANCTIONS_CACHE: str("data/ofac-sdn-addresses.json"),
  ELIGIBILITY_SANCTIONS_ORACLE: address,
  ELIGIBILITY_TRUST_PROXY: flag,
  ELIGIBILITY_ALLOW_UNKNOWN_IP: flag,
  ELIGIBILITY_IP_LIMIT: int(10, 1),
  ELIGIBILITY_ADDRESS_LIMIT: int(5, 1),

  // mcp (+ token issuance in the api)
  MCP_PORT: port(DEFAULT_PORTS.mcp),
  MCP_TOKEN_SECRET: z.preprocess(blank, z.string().min(32, "must be at least 32 characters").optional()),
  PLINTH_MCP_TOKEN: opt,
  RPC_URL: optUrl,
  DEPLOYMENT_JSON: opt,

  // treasury (shared by the treasury services)
  TREASURY_RPC_URL: optUrl,
  TREASURY_CHAIN_ID: optInt(1),
  TREASURY_POLL_MS: optInt(1),
  TREASURY_ACCOUNT: address,
  TREASURY_ACCOUNTS: list,
  TREASURY_FACTORY: address,
  ...signer("TREASURY_CONTROLLER"),
  // treasury-desks
  TREASURY_DESKS_PORT: port(DEFAULT_PORTS["treasury-desks"]),
  TREASURY_CONFIG: opt,
  TREASURY_DESK_INTERVAL_S: int(300, 1),
  ...signer("TREASURY_CASH_DESK"),
  ...signer("TREASURY_EQUITY_DESK"),
  TREASURY_JURY: z.preprocess(blank, z.enum(["on", "off"]).default("on")),
  OLLAMA_HOST: opt,
  TREASURY_JURY_MODELS: opt,
  TREASURY_JURY_TIMEOUT_MS: optInt(1),
  // treasury-close
  TREASURY_CLOSE_PORT: port(DEFAULT_PORTS["treasury-close"]),
  TREASURY_PERIOD_CLOSE: address,
  TREASURY_CLOSE_INTERVAL_S: int(600, 1),
  TREASURY_CLOSE_SKIP_RECONCILE: flag,
  // treasury-risk
  TREASURY_RISK_PORT: port(DEFAULT_PORTS["treasury-risk"]),
  TREASURY_POSITION_MIRROR: address,
  RISK_STATIC_READERS: opt,
  RISK_WEBHOOK_URLS: list,
  RISK_WEBHOOK_SECRET: opt,
  RISK_INTERVAL_SEC: int(30, 1),
  RISK_HYSTERESIS_BPS: int(50),
  RISK_ONCE: flag,
  // treasury-receipts
  TREASURY_RECEIPTS_PORT: port(DEFAULT_PORTS["treasury-receipts"]),
  TREASURY_RECEIPTS: address,
  TREASURY_RECEIPTS_INTERVAL_S: int(300, 1),
  TREASURY_RECEIPTS_GRACE_S: int(300),
  // treasury-marks
  TREASURY_MARKS_PORT: port(DEFAULT_PORTS["treasury-marks"]),
  TREASURY_MARK_INTERVAL_S: int(60, 1),
  // treasury-reconciler
  TREASURY_RECONCILER_PORT: port(DEFAULT_PORTS["treasury-reconciler"]),
  TREASURY_RECONCILE_CONFIG: opt,
  TREASURY_RECONCILE_INTERVAL_S: int(3600, 1),
  ORDERLY_SECRET: opt,
  TREASURY_WEBHOOK_URLS: list,
  TREASURY_WEBHOOK_SECRET: opt,
  // treasury-webhooks
  TREASURY_WEBHOOKS_PORT: port(DEFAULT_PORTS["treasury-webhooks"]),
  TREASURY_WEBHOOK_INTERVAL_S: int(15, 1),
});

type Parsed = z.infer<typeof schema>;
export type ConfigKey = keyof Parsed;
/** Settings records for the helpers that take named variables (signers, Plaid, eligibility, jury). */
export type Env = Readonly<Record<string, string | undefined>>;
export type Config = Readonly<Parsed> & {
  /** The same validated values (defaults applied) as strings, for helpers that take an Env record. */
  readonly env: Env;
};

export const CONFIG_KEYS = Object.keys(schema.shape) as ConfigKey[];

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "environment"}: ${i.message}`).join("; ");

const toEnvString = (v: unknown): string | undefined =>
  v === undefined ? undefined : typeof v === "boolean" ? (v ? "1" : "0") : Array.isArray(v) ? v.join(",") : String(v);

/** Validates every variable; throws ConfigurationError naming each bad one. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(source);
  if (!r.success) throw new ConfigurationError(`invalid configuration: ${issues(r.error)}`);
  const env: Record<string, string | undefined> = {};
  for (const k of CONFIG_KEYS) env[k] = toEnvString(r.data[k]);
  return Object.freeze({ ...r.data, env: Object.freeze(env) });
}

/** One validated value (default applied), for library code outside the bin/ entries. */
export function configValue<K extends ConfigKey>(key: K, source: Record<string, string | undefined> = process.env): Parsed[K] {
  const r = schema.shape[key].safeParse(source[key]);
  if (!r.success) throw new ConfigurationError(`invalid configuration: ${key}: ${r.error.issues.map((i) => i.message).join(", ")}`);
  return r.data as Parsed[K];
}

/**
 * A variable whose NAME is chosen at run time, e.g. the webhook secret named by `--secret-env NAME` (so the secret
 * never appears in shell history). Only for names the operator passes explicitly.
 */
export function namedSecret(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new ConfigurationError(`bad environment variable name ${name}`);
  const v = source[name]?.trim();
  return v ? v : undefined;
}

/** Whether a variable was given a non-blank value (as opposed to falling back to its default). */
export function isSet(key: ConfigKey, source: Record<string, string | undefined> = process.env): boolean {
  return blank(source[key]) !== undefined;
}

/** The RPC URL for a chain name: LOCAL_RPC_URL, RHC_TESTNET_RPC_URL or RHC_MAINNET_RPC_URL. */
export function rpcUrlFor(config: Pick<Parsed, "LOCAL_RPC_URL" | "RHC_TESTNET_RPC_URL" | "RHC_MAINNET_RPC_URL">, chainName: ChainName): string {
  return chainName === "mainnet" ? config.RHC_MAINNET_RPC_URL : chainName === "testnet" ? config.RHC_TESTNET_RPC_URL : config.LOCAL_RPC_URL;
}

const SECRET = /(KEY|SECRET|PASSWORD|TOKEN)(_FILE)?$|^DATABASE_URL$|RPC_URL$/;
/** What a service may log about its configuration: secrets and URLs (which can carry credentials) only as "set". */
export function safeConfigSummary(config: Config, keys: readonly ConfigKey[] = CONFIG_KEYS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = config[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = SECRET.test(k) && !k.endsWith("_KEYSTORE_PASSWORD_FILE") && !k.endsWith("_KEYSTORE") ? "[set]" : v;
  }
  return out;
}

/** The variables one service reads, for its startup summary. */
export function keysFor(...prefixes: string[]): ConfigKey[] {
  return CONFIG_KEYS.filter((k) => prefixes.some((p) => k.startsWith(p)));
}
