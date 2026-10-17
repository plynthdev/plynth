// Called by up.sh (and runnable alone) AFTER the manual mainnet deploy (MainnetBeta.s.sol, docs runbook): turns
// the script's output into deployments/4663.json + 4663-treasury.json, checks the chain is 4663 and that OWNER
// accepted every two-step ownership, reports the bots' ETH, prepares the plynth_mainnet database and writes one
// env file per service. It never deploys and never sends a transaction.
//
//   bun scripts/mainnet/setup.ts [--check-only]
import { createDatabaseIfMissing, databaseUrl, runMigrations, withDatabase } from "@/db";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { PORTS } from "../fork/lib";
import {
  assertMainnet, DB_NAME, ensureDirs, envFileText, fmtEth, keystoreVars, log, MAINNET_CHAIN_ID, MAINNET_DIR, MIN_CONFIRMATIONS, normalizeDeployment, PATHS, readDeployment, ROOT, RPC, secrets,
} from "./lib";

const ownedAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
/** Below this a bot is reported as unfunded (runbook: fund before starting the services). */
export const BOT_FLOOR_WEI = 100_000_000_000_000n; // 0.0001 ETH

const pub = () => createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 6, retryDelay: 750 }) });

/** deployments/4663.json from the raw output, deployBlock from the broadcast receipts. Once. */
async function ensureDeploymentFile() {
  if (existsSync(PATHS.deployment)) return;
  if (!existsSync(PATHS.raw)) throw new Error(`no ${PATHS.raw}: run the mainnet deploy first (docs runbook, after Kal's go)`);
  const raw = JSON.parse(readFileSync(PATHS.raw, "utf8")) as Record<string, unknown>;
  let deployBlock: number | undefined;
  if (existsSync(PATHS.broadcast)) {
    const run = JSON.parse(readFileSync(PATHS.broadcast, "utf8")) as { receipts: { blockNumber: Hex }[] };
    const blocks = run.receipts.map((r) => Number(BigInt(r.blockNumber)));
    if (blocks.length) deployBlock = Math.min(...blocks);
  }
  if (deployBlock === undefined) throw new Error(`no broadcast receipts at ${PATHS.broadcast}: cannot tell the deploy block`);
  const { main, treasury } = normalizeDeployment(raw, deployBlock);
  writeFileSync(PATHS.deployment, `${JSON.stringify(main, null, 2).replace(/^(\s*"(\w*[pP]oolId)": "0x[0-9a-fA-F]{64}")/gm, '$1, "$2Note": "v4 pool id // not-a-key"')}\n`);
  writeFileSync(PATHS.treasuryDeployment, `${JSON.stringify(treasury, null, 2)}\n`);
  log(`wrote ${PATHS.deployment} (deploy block ${deployBlock})`);
}

/** Two-step ownerships OWNER has not accepted yet (empty = handed over). */
export async function pendingAccepts(owner: Address, list: Address[], read: (a: Address, fn: "owner" | "pendingOwner") => Promise<Address>): Promise<Address[]> {
  const out: Address[] = [];
  for (const a of list) if (getAddress(await read(a, "owner")) !== getAddress(owner)) out.push(getAddress(a));
  return out;
}

/** One env file per service (keystore paths only). Mainnet: confirmations >= 2, no unknown-IP pass for eligibility. */
export function envFiles(dep: Record<string, unknown>, s: { keeperSecretKey: Hex; mcpTokenSecret: string }, db: string, confirmations = MIN_CONFIRMATIONS): Record<string, Record<string, string | number>> {
  if (confirmations < MIN_CONFIRMATIONS) throw new Error(`confirmations ${confirmations} < ${MIN_CONFIRMATIONS} on mainnet`);
  const depDir = PATHS.deployments;
  const shared = { DATABASE_URL: db, RHC_MAINNET_RPC_URL: RPC, LOG_LEVEL: "info" };
  const treasury = { ...shared, TREASURY_RPC_URL: RPC, TREASURY_CHAIN_ID: MAINNET_CHAIN_ID, TREASURY_FACTORY: dep.treasuryFactory as string, TREASURY_POLL_MS: 2000 };
  const elig = {
    ELIGIBILITY_CHAIN: "mainnet",
    ELIGIBILITY_REGISTRY: dep.eligibilityRegistry as string,
    ...keystoreVars("ELIGIBILITY", "attester"),
    ELIGIBILITY_IP_DB: join(ROOT, "app", "data", "dbip-country-lite.mmdb"),
    ELIGIBILITY_SANCTIONS_CACHE: join(ROOT, "app", "data", "ofac-sdn-addresses.json"),
  };
  return {
    indexer: { ...shared, INDEXER_CHAIN: "mainnet", INDEXER_PORT: PORTS.indexer, INDEXER_DEPLOYMENTS_DIR: depDir, INDEXER_POLL_MS: 4000, INDEXER_CONFIRMATIONS: confirmations },
    keeper: { ...shared, KEEPER_CHAIN: "mainnet", KEEPER_PORT: PORTS.keeper, KEEPER_DEPLOYMENTS_DIR: depDir, ...keystoreVars("KEEPER", "keeper"), KEEPER_SECRET_KEY: s.keeperSecretKey, KEEPER_INTERVAL_MS: 20_000, KEEPER_CONFIRMATIONS: confirmations, SPLIT_PARTS: 2 },
    relayer: { ...shared, RELAYER_CHAIN: "mainnet", RELAYER_PORT: PORTS.relayer, RELAYER_DEPLOYMENTS_DIR: depDir, ...keystoreVars("RELAYER", "relayer"), RELAYER_IP_LIMIT: 100, RELAYER_STEALTH_LIMIT: 20 },
    api: { ...shared, ...elig, API_CHAIN: "mainnet", API_PORT: PORTS.api, API_DEPLOYMENTS_DIR: depDir, ROUNDUPS_ENABLED: 1, KEEPER_SECRET_KEY: s.keeperSecretKey, MCP_TOKEN_SECRET: s.mcpTokenSecret },
    eligibility: { ...shared, ...elig, ELIGIBILITY_PORT: PORTS.eligibility },
    mcp: { ...shared, RPC_URL: RPC, MCP_PORT: PORTS.mcp, MCP_TOKEN_SECRET: s.mcpTokenSecret, DEPLOYMENT_JSON: PATHS.deployment },
    "treasury-marks": { ...treasury, TREASURY_MARKS_PORT: PORTS["treasury-marks"], TREASURY_MARK_INTERVAL_S: 300 },
    "treasury-webhooks": { ...treasury, TREASURY_WEBHOOKS_PORT: PORTS["treasury-webhooks"] },
  };
}

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  ensureDirs();
  await assertMainnet();
  await ensureDeploymentFile();
  const dep = readDeployment()!;
  const p = pub();
  const id = await p.getChainId();
  if (id !== MAINNET_CHAIN_ID) throw new Error(`chain id ${id}`);
  const code = await p.getCode({ address: getAddress(dep.savingsVault as string) });
  if (!code || code === "0x") throw new Error(`savingsVault ${dep.savingsVault} has no code on 4663: wrong deployment file`);
  const left = await pendingAccepts(dep.owner, dep.acceptOwnership ?? [], (a, fn) => p.readContract({ address: a, abi: ownedAbi, functionName: fn }) as Promise<Address>);
  if (left.length) {
    throw new Error(`OWNER ${dep.owner} has not accepted ownership of ${left.length} contract(s) yet: call acceptOwnership() from OWNER on ${left.join(", ")} (runbook step 6)`);
  }
  log("OWNER holds every two-step ownership; release gate before inviting users: bun run release:gate");
  for (const role of ["keeper", "relayer", "controller", "cashDesk", "equityDesk"] as const) {
    const a = dep[role];
    if (typeof a !== "string") continue;
    const bal = await p.getBalance({ address: getAddress(a) });
    log(`${role.padEnd(10)} ${a} ${fmtEth(bal)} ETH${bal < BOT_FLOOR_WEI ? "  <- UNFUNDED (runbook step 7)" : ""}`);
  }
  if (checkOnly) return;
  const db = withDatabase(databaseUrl(), DB_NAME);
  if (await createDatabaseIfMissing(db)) log(`created database ${DB_NAME}`);
  await runMigrations(db);
  const files = envFiles(dep, secrets(), db);
  for (const n of ["treasury-desks", "treasury-close", "treasury-risk", "treasury-receipts"]) rmSync(join(PATHS.env, `${n}.env`), { force: true });
  for (const [name, vars] of Object.entries(files)) writeFileSync(join(PATHS.env, `${name}.env`), envFileText(vars), { mode: 0o600 });
  log(`env files in ${PATHS.env} (dir ${MAINNET_DIR})`);
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error(`[mainnet setup] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
