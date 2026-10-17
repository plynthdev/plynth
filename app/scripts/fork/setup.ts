// Called by up.sh once anvil answers: deploys the whole stack if the fork state has none, funds the dev
// accounts, prepares the plynth_fork database and writes one env file per service for up.sh to start.
// Idempotent: on a restart with an existing state file it only checks the deployment and rewrites env files.
import { createDatabaseIfMissing, databaseUrl, runMigrations, withDatabase } from "@/db";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BETA_DEPLOYER_INDEX, clients, DB_NAME, devAccount, devKey, ensureDirs, FORK_CHAIN_ID, FORK_DIR, forkStack, log, PATHS, PORTS, readForkDeployment, ROLE, ROOT, RPC, secrets, splitDeployment, waitForRpc } from "./lib";
import { clearAccountCode, fund, giveEth, giveUsdg, prefundDeployer, U, USDG } from "./fund";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
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
  const stack = forkStack();
  log(`stripped EIP-7702 code from ${await clearAccountCode()} dev accounts`);
  await giveEth();
  await prefundDeployer();
  // Warm first: the public RPC serves the fork block's state for ~10-15 minutes only.
  await warmReal();
  const startBlock = Number(await pub.getBlockNumber());
  const script = stack === "beta" ? "MainnetBeta" : "ForkMainnet";
  const beta = stack === "beta" ? await prepareBetaDeployer() : undefined;
  const safe = beta ? await deployOwnerSafe() : undefined;
  log(`forge script ${script} (broadcast to the local fork only)`);
  const env = {
    ...process.env,
    FORK_KEEPER: devAccount(ROLE.keeper).address,
    FORK_ATTESTER: devAccount(ROLE.attester).address,
    FORK_COMMITTEE: devAccount(ROLE.committee).address,
    ...(beta ? betaEnv(beta.token, safe) : {}),
  };
  const sender = beta ? beta.deployer : devAccount(ROLE.deployer).address;
  const r = Bun.spawnSync(
    // Beta: 2x gas limits, as on mainnet (runbook): forge simulates every call in one block, but a PerpMarket's
    // setParams accrues the time since its constructor's block when broadcast and ran out of a 1.3x limit.
    ["forge", "script", `script/${script}.s.sol:${script}`, "--rpc-url", RPC, "--broadcast", "--unlocked", "--sender", sender, "--non-interactive", ...(beta ? ["--gas-estimate-multiplier", "200"] : [])],
    { cwd: join(ROOT, "contracts"), env, stdout: "pipe", stderr: "pipe" },
  );
  const out = r.stdout.toString() + r.stderr.toString();
  writeFileSync(join(PATHS.logs, "deploy.log"), out);
  if (beta) await clients().rpc("anvil_stopImpersonatingAccount", [beta.deployer]);
  if (r.exitCode !== 0) throw new Error(`forge script failed (exit ${r.exitCode}); see ${join(PATHS.logs, "deploy.log")}\n${out.slice(-3000)}`);
  if (beta) recordDeployGas(script);
  // Forge's broadcast records for chain 31337 are fork output, not a deployment: keep them out of the repo tree.
  for (const d of ["broadcast", "cache"]) rmSync(join(ROOT, "contracts", d, `${script}.s.sol`, String(FORK_CHAIN_ID)), { recursive: true, force: true });
  const raw = JSON.parse(readFileSync(PATHS.forgeOut, "utf8"));
  const { main, treasury } = splitDeployment(raw, startBlock + 1);
  writeFileSync(join(PATHS.deployments, `${FORK_CHAIN_ID}.json`), JSON.stringify(main, null, 2));
  writeFileSync(join(PATHS.deployments, `${FORK_CHAIN_ID}-treasury.json`), JSON.stringify(treasury, null, 2));
  writeFileSync(PATHS.forgeOut, JSON.stringify(main, null, 2));
  writeFileSync(PATHS.stack, stack);
  log(`deployed (${stack} stack): ${Object.keys(main).length} entries in ${PATHS.forgeOut}`);
  if (beta) await betaAfterDeploy(main);
  await warmPlynth();
  await fund();
  rmSync(PATHS.exercised, { force: true });
}

// ---------------------------------------------------------------- beta stack (MainnetBeta.s.sol, fork mode)

/**
 * Placeholder OWNER and bots on the fork. OWNER is a 2-of-3 Safe stand-in (MockSafe: getThreshold / getOwners, as
 * the mainnet owner pin reads them) owned by dev accounts 0-2 when one was deployed (`owner`), else dev account 0;
 * the setup and the exercise act as it by anvil impersonation. Bots are dev accounts, so services can sign.
 */
export function betaEnv(token: boolean, owner?: Address): Record<string, string> {
  return {
    BETA_FORK: "true",
    BETA_OUT: "fork.json",
    DEPLOY_TOKEN: token ? "true" : "false",
    OWNER: owner ?? devAccount(ROLE.deployer).address,
    KEEPER: devAccount(ROLE.keeper).address,
    ATTESTER: devAccount(ROLE.attester).address,
    RELAYER: devAccount(ROLE.relayer).address,
    CONTROLLER: devAccount(ROLE.controller).address,
    CASH_DESK: devAccount(ROLE.cash).address,
    EQUITY_DESK: devAccount(ROLE.equity).address,
  };
}

/**
 * The deployer acts by impersonation (no key): FORK_BETA_DEPLOYER (e.g. the real mainnet deployer's public
 * address, so the fork predicts the real contract addresses) or dev account 37. Token mode needs its USDG.
 */
async function prepareBetaDeployer(): Promise<{ deployer: Address; token: boolean }> {
  const { pub, rpc } = clients();
  const deployer = getAddress(process.env.FORK_BETA_DEPLOYER || devAccount(BETA_DEPLOYER_INDEX).address);
  const token = (process.env.FORK_BETA_TOKEN ?? "true") !== "false";
  const code = await pub.getCode({ address: deployer });
  if (code && code !== "0x") await rpc("anvil_setCode", [deployer, "0x"]);
  await rpc("anvil_setBalance", [deployer, "0x56bc75e2d63100000"]); // 100 ETH
  await rpc("anvil_impersonateAccount", [deployer]);
  if (token) await giveUsdg(deployer, 60_000n * U);
  log(`beta deployer ${deployer} (impersonated, nonce ${await pub.getTransactionCount({ address: deployer })}), DEPLOY_TOKEN=${token}`);
  return { deployer, token };
}

/**
 * OWNER on the beta fork: a 2-of-3 Safe stand-in (contracts/test/mocks/MockSafe.sol) owned by dev accounts 0-2, so
 * the deploy's and verify:deployment's owner pin (a contract with getThreshold() >= 2 and enough owners) is
 * exercised. Its ownership calls are sent by anvil impersonation (a real Safe would collect two signatures).
 */
async function deployOwnerSafe(): Promise<Address> {
  const { pub, wallet, rpc } = clients();
  const art = JSON.parse(readFileSync(join(ROOT, "contracts", "out", "MockSafe.sol", "MockSafe.json"), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  const owners = [0, 1, 2].map((i) => devAccount(i).address);
  const w = wallet(devAccount(ROLE.deployer));
  const hash = await w.deployContract({ abi: art.abi as never, bytecode: art.bytecode.object, args: [owners, 2n] } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("MockSafe deploy reverted");
  const safe = getAddress(rc.contractAddress);
  await rpc("anvil_setBalance", [safe, "0x56bc75e2d63100000"]); // 100 ETH for its own transactions
  writeFileSync(PATHS.ownerSafe, safe);
  log(`OWNER: 2-of-3 Safe stand-in ${safe} (owners dev accounts 0-2)`);
  return safe;
}

/** Gas of every broadcast transaction (receipts), for the mainnet cost estimate. */
function recordDeployGas(script: string) {
  const f = join(ROOT, "contracts", "broadcast", `${script}.s.sol`, String(FORK_CHAIN_ID), "run-latest.json");
  const run = JSON.parse(readFileSync(f, "utf8")) as { transactions: { transaction: { input?: Hex; data?: Hex; to?: string | null }; contractName?: string; transactionType?: string }[]; receipts: { gasUsed: Hex; transactionHash: Hex }[] };
  const txs = run.transactions.map((t, i) => ({
    contract: t.contractName ?? null,
    type: t.transactionType ?? null,
    to: t.transaction.to ?? null,
    data: (t.transaction.input ?? t.transaction.data ?? "0x") as Hex,
    gasUsed: String(BigInt(run.receipts[i]!.gasUsed)),
  }));
  writeFileSync(PATHS.deployGas, JSON.stringify({ script, txs }, null, 2));
  log(`deploy gas: ${txs.length} txs, ${txs.reduce((a, t) => a + BigInt(t.gasUsed), 0n)} gas (${PATHS.deployGas})`);
}

const acceptAbi = parseAbi(["function acceptOwnership()", "function approve(address, uint256) returns (bool)", "function deposit(uint256 assets, address receiver) returns (uint256)"]);

/** OWNER accepts every two-step ownership (what Kal does after the real deploy), then seeds the perp pool's LP side. */
async function betaAfterDeploy(main: Record<string, unknown>) {
  const { pub, wallet, rpc } = clients();
  const owner = devAccount(ROLE.deployer);
  const w = wallet(owner);
  // OWNER (the Safe stand-in) accepts by impersonation; the LP seed below stays dev account 0's.
  const ownerAddr = getAddress(main.owner as string);
  await rpc("anvil_impersonateAccount", [ownerAddr]);
  const asOwner = (to: Address, data: Hex) => rpc<Hex>("eth_sendTransaction", [{ from: ownerAddr, to, data }]);
  for (const a of (main.acceptOwnership ?? []) as Address[]) {
    const rc = await pub.waitForTransactionReceipt({ hash: await asOwner(getAddress(a), encodeFunctionData({ abi: acceptAbi, functionName: "acceptOwnership" })) });
    if (rc.status !== "success") throw new Error(`acceptOwnership on ${a} reverted`);
  }
  log(`OWNER accepted ${(main.acceptOwnership as Address[] | undefined)?.length ?? 0} ownerships`);
  // The token deploy sends OWNER the PLTH left after the pool; the exercise's board (dev account 0) stakes it.
  if (typeof main.plth === "string") {
    const plth = getAddress(main.plth);
    const bal = await pub.readContract({ address: plth, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [ownerAddr] });
    if (bal > 0n) {
      const rc = await pub.waitForTransactionReceipt({ hash: await asOwner(plth, encodeFunctionData({ abi: parseAbi(["function transfer(address, uint256) returns (bool)"]), functionName: "transfer", args: [owner.address, bal] })) });
      if (rc.status !== "success") throw new Error("PLTH hand-on to the board reverted");
      log(`OWNER passed ${bal} PLTH (raw) to the board, dev account 0`);
    }
  }
  const lp = 1_000_000n * U;
  const pool = getAddress(main.perpPool as string);
  for (const data of [encodeFunctionData({ abi: acceptAbi, functionName: "approve", args: [pool, lp] })]) {
    const rc = await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: USDG, data }) });
    if (rc.status !== "success") throw new Error("USDG approve for the perp pool reverted");
  }
  const rc = await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: pool, data: encodeFunctionData({ abi: acceptAbi, functionName: "deposit", args: [lp, owner.address] }) }) });
  if (rc.status !== "success") throw new Error("perp pool LP seed reverted");
  log("OWNER seeded the perp pool with 1,000,000 USDG");
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

if (import.meta.main) {
  await main();
  process.exit(0);
}
