// Called by up.sh once anvil answers: deploys the whole stack if the fork state has none, funds the dev
// accounts, prepares the plynth_fork database and writes one env file per service for up.sh to start.
// Idempotent: on a restart with an existing state file it only checks the deployment and rewrites env files.
import { createDatabaseIfMissing, databaseUrl, runMigrations, withDatabase } from "@/db";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clients, DB_NAME, devAccount, devKey, ensureDirs, FORK_CHAIN_ID, FORK_DIR, log, PATHS, PORTS, readForkDeployment, ROLE, ROOT, RPC, secrets, splitDeployment, waitForRpc } from "./lib";
import { clearAccountCode, fund, giveEth, prefundDeployer } from "./fund";
import { warmPlynth, warmReal } from "./warm";

async function deployed(): Promise<boolean> {
  const dep = readForkDeployment();
  if (!dep) return false;
  const { pub } = clients();
  const code = await pub.getCode({ address: dep.savingsVault as `0x${string}` });
  if (!code || code === "0x") {
    log("deployment file found but the fork has no code there (state was reset): deploying again");
    return false;
  }
  return true;
}

async function deploy() {
  const { pub } = clients();
  log(`stripped EIP-7702 code from ${await clearAccountCode()} dev accounts`);
  await giveEth();
  await prefundDeployer();
  // Warm first: the public RPC serves the fork block's state for ~10-15 minutes only.
  await warmReal();
  const startBlock = Number(await pub.getBlockNumber());
  log("forge script ForkMainnet (broadcast to the local fork only)");
  const env = {
    ...process.env,
    FORK_KEEPER: devAccount(ROLE.keeper).address,
    FORK_ATTESTER: devAccount(ROLE.attester).address,
    FORK_COMMITTEE: devAccount(ROLE.committee).address,
  };
  const r = Bun.spawnSync(
    ["forge", "script", "script/ForkMainnet.s.sol:ForkMainnet", "--rpc-url", RPC, "--broadcast", "--unlocked", "--sender", devAccount(ROLE.deployer).address, "--non-interactive"],
    { cwd: join(ROOT, "contracts"), env, stdout: "pipe", stderr: "pipe" },
  );
  const out = r.stdout.toString() + r.stderr.toString();
  writeFileSync(join(PATHS.logs, "deploy.log"), out);
  if (r.exitCode !== 0) throw new Error(`forge script failed (exit ${r.exitCode}); see ${join(PATHS.logs, "deploy.log")}\n${out.slice(-3000)}`);
  // Forge's broadcast records for chain 31337 are fork output, not a deployment: keep them out of the repo tree.
  for (const d of ["broadcast", "cache"]) rmSync(join(ROOT, "contracts", d, "ForkMainnet.s.sol", String(FORK_CHAIN_ID)), { recursive: true, force: true });
  const raw = JSON.parse(readFileSync(PATHS.forgeOut, "utf8"));
  const { main, treasury } = splitDeployment(raw, startBlock + 1);
  writeFileSync(join(PATHS.deployments, `${FORK_CHAIN_ID}.json`), JSON.stringify(main, null, 2));
  writeFileSync(join(PATHS.deployments, `${FORK_CHAIN_ID}-treasury.json`), JSON.stringify(treasury, null, 2));
  writeFileSync(PATHS.forgeOut, JSON.stringify(main, null, 2));
  log(`deployed: ${Object.keys(main).length} entries in ${PATHS.forgeOut}`);
  await warmPlynth();
  await fund();
  rmSync(PATHS.exercised, { force: true });
}

function writeEnv(name: string, vars: Record<string, string | number | undefined>) {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(PATHS.env, `${name}.env`), `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** One env file per service; up.sh sources it in a subshell. Keys are anvil's public dev keys. */
function writeEnvFiles() {
  const dep = readForkDeployment()!;
  const s = secrets();
  const db = withDatabase(databaseUrl(), DB_NAME);
  const depDir = PATHS.deployments;
  const shared = { DATABASE_URL: db, LOCAL_RPC_URL: RPC, LOG_LEVEL: "info" };
  const treasury = { ...shared, TREASURY_RPC_URL: RPC, TREASURY_FACTORY: dep.treasuryFactory as string, TREASURY_POLL_MS: 100 };
  const elig = {
    ELIGIBILITY_CHAIN: "local",
    ELIGIBILITY_REGISTRY: dep.eligibilityRegistry as string,
    ELIGIBILITY_ATTESTER_KEY: devKey(ROLE.attester),
    // Requests to a local fork come from 127.0.0.1, which has no country: let them through (dev only).
    ELIGIBILITY_ALLOW_UNKNOWN_IP: 1,
    ELIGIBILITY_IP_LIMIT: 1000,
    ELIGIBILITY_ADDRESS_LIMIT: 100,
    ELIGIBILITY_IP_DB: join(ROOT, "app", "data", "dbip-country-lite.mmdb"),
    ELIGIBILITY_SANCTIONS_CACHE: join(ROOT, "app", "data", "ofac-sdn-addresses.json"),
  };
  writeEnv("indexer", { ...shared, INDEXER_CHAIN: "local", INDEXER_PORT: PORTS.indexer, INDEXER_DEPLOYMENTS_DIR: depDir, INDEXER_POLL_MS: 1000, INDEXER_CONFIRMATIONS: 0 });
  writeEnv("keeper", {
    ...shared,
    KEEPER_CHAIN: "local",
    KEEPER_PORT: PORTS.keeper,
    KEEPER_DEPLOYMENTS_DIR: depDir,
    KEEPER_PRIVATE_KEY: devKey(ROLE.keeper),
    KEEPER_SECRET_KEY: s.keeperSecretKey,
    KEEPER_INTERVAL_MS: process.env.FORK_KEEPER_INTERVAL_MS || 3000,
    SPLIT_PARTS: 2,
  });
  writeEnv("relayer", { ...shared, RELAYER_CHAIN: "local", RELAYER_PORT: PORTS.relayer, RELAYER_DEPLOYMENTS_DIR: depDir, RELAYER_PRIVATE_KEY: devKey(ROLE.relayer), RELAYER_IP_LIMIT: 1000, RELAYER_STEALTH_LIMIT: 100 });
  writeEnv("api", { ...shared, ...elig, API_CHAIN: "local", API_PORT: PORTS.api, API_DEPLOYMENTS_DIR: depDir, ROUNDUPS_ENABLED: 1, KEEPER_SECRET_KEY: s.keeperSecretKey, MCP_TOKEN_SECRET: s.mcpTokenSecret });
  writeEnv("eligibility", { ...shared, ...elig, ELIGIBILITY_PORT: PORTS.eligibility });
  writeEnv("mcp", { ...shared, RPC_URL: RPC, MCP_PORT: PORTS.mcp, MCP_TOKEN_SECRET: s.mcpTokenSecret, DEPLOYMENT_JSON: join(depDir, `${FORK_CHAIN_ID}.json`) });
  writeEnv("treasury-marks", { ...treasury, TREASURY_MARKS_PORT: PORTS["treasury-marks"], TREASURY_MARK_INTERVAL_S: 60 });
  writeEnv("treasury-webhooks", { ...treasury, TREASURY_WEBHOOKS_PORT: PORTS["treasury-webhooks"] });

  // The per-treasury services need a treasury: exercise.ts creates one and writes treasury/services.json. Until
  // then up.sh does not start them (exercise drives them itself with --once passes).
  const tf = join(PATHS.treasury, "services.json");
  for (const n of ["treasury-desks", "treasury-close", "treasury-risk", "treasury-receipts", "treasury-reconciler"]) rmSync(join(PATHS.env, `${n}.env`), { force: true });
  if (existsSync(tf)) {
    const t = JSON.parse(readFileSync(tf, "utf8")) as Record<string, string>;
    const controller = { TREASURY_CONTROLLER_KEY: devKey(ROLE.controller) };
    writeEnv("treasury-desks", { ...treasury, TREASURY_DESKS_PORT: PORTS["treasury-desks"], TREASURY_CONFIG: t.desksConfig, TREASURY_CASH_DESK_KEY: devKey(ROLE.cash), TREASURY_EQUITY_DESK_KEY: devKey(ROLE.equity) });
    writeEnv("treasury-close", { ...treasury, ...controller, TREASURY_CLOSE_PORT: PORTS["treasury-close"], TREASURY_PERIOD_CLOSE: t.periodClose, TREASURY_CLOSE_SKIP_RECONCILE: 1 });
    writeEnv("treasury-risk", { ...treasury, ...controller, TREASURY_RISK_PORT: PORTS["treasury-risk"], TREASURY_ACCOUNT: t.account });
    writeEnv("treasury-receipts", { ...treasury, ...controller, TREASURY_RECEIPTS_PORT: PORTS["treasury-receipts"], TREASURY_RECEIPTS: dep.receipts as string });
    if (t.reconcileConfig) writeEnv("treasury-reconciler", { ...treasury, TREASURY_RECONCILER_PORT: PORTS["treasury-reconciler"], TREASURY_RECONCILE_CONFIG: t.reconcileConfig });
  }
}

async function main() {
  ensureDirs();
  await waitForRpc();
  if (!(await deployed())) await deploy();
  else log("deployment present in the fork state: skipping deploy");
  const db = withDatabase(databaseUrl(), DB_NAME);
  if (await createDatabaseIfMissing(db)) log(`created database ${DB_NAME}`);
  await runMigrations(db);
  writeEnvFiles();
  log(`env files in ${PATHS.env} (fork dir ${FORK_DIR})`);
}

await main();
process.exit(0);
