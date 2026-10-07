// Called by up.sh (and runnable alone): deploys the whole stack to Robinhood Chain TESTNET (46630) once, funds the
// service and exercise wallets from the deployer up to fixed targets, hands the mock feeds to the keeper,
// prepares the plynth_testnet database and writes one env file per service.
//
//   bun scripts/testnet/setup.ts [--estimate-only]
//
// Idempotent: a deployment file whose savingsVault has code is kept; wallets already at their target get
// nothing; the feeds already owned by the keeper are left alone. Every send is chain-id guarded (lib.ts).
// Before the deploy it estimates the whole broadcast (forge simulation, L2 gas + Orbit L1 data gas) and refuses
// to broadcast if the deployer would end below 0.001 ETH after the deploy and the funding plan.
import { createDatabaseIfMissing, databaseUrl, runMigrations, withDatabase } from "@/db";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, formatEther, getAddress, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { mainnetFeedReader, mockAnswerFor } from "@/keeper/jobs/mock-feeds";
import {
  affordable, appendLedger, assertTestnet, clients, DB_NAME, ensureDirs, fmtEth, keystorePath, log, MAINNET_RPC, passwordFile, PATHS, PORTS, readDeployment,
  role, ROOT, RPC, secrets, testers, TESTNET_CHAIN_ID, TESTNET_DIR, topUpAmount, WALLETS, type Role,
} from "./lib";

/** Minimum the deployer keeps (todo 38). */
export const DEPLOYER_FLOOR = parseEther("0.001");
/** ETH each wallet is topped up to (measured: fork report gas per tx x expected count, 0.01 gwei). */
export const ETH_TARGETS: Partial<Record<Role, bigint>> = {
  keeper: parseEther("0.0015"), // feed refresh every 10 min (~3 x 50k gas) + sweeps, beacons, executions, deliveries
  relayer: parseEther("0.0004"),
  controller: parseEther("0.0004"),
  cashDesk: parseEther("0.0002"),
  equityDesk: parseEther("0.0002"),
  open: parseEther("0.0003"),
  quiet: parseEther("0.0003"),
  hidden: parseEther("0.0003"),
  spender: parseEther("0.0001"),
};
/** Per tester wallet (MetaMask click-through): 0.0005 ETH is plenty at 0.01 gwei, and 10,000 mock USDG once. */
export const TESTER_ETH = parseEther("0.0005");
export const TESTER_USDG = 10_000n * 1_000_000n;
/** Keeper float for pool alignment swaps (runbooks/testnet.md): 1M mUSDG + 10k of each mock stock. */
export const KEEPER_USDG_FLOAT = 1_000_000n * 1_000_000n;
export const KEEPER_STOCK_FLOAT = 10_000n * 10n ** 18n;

const mintAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
]);
const nodeInterface = "0x00000000000000000000000000000000000000C8" as Address;
const nodeAbi = parseAbi(["function gasEstimateComponents(address to, bool contractCreation, bytes data) returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);

const CONTRACTS = join(ROOT, "contracts");
const BROADCAST = join(CONTRACTS, "broadcast", "TestnetStack.s.sol", String(TESTNET_CHAIN_ID));

async function deployed(): Promise<boolean> {
  const dep = readDeployment();
  if (!dep || typeof dep.savingsVault !== "string") return false;
  const code = await clients().pub.getCode({ address: dep.savingsVault as Address });
  if (!code || code === "0x") {
    log(`deployment file names savingsVault ${dep.savingsVault} but it has no code on testnet: deploying again`);
    return false;
  }
  return true;
}

/** Today's real per-share prices (8 dp) for the three mocks, so the pools start where the keeper will keep them. */
async function realPrices(): Promise<Record<string, string>> {
  const reader = mainnetFeedReader(createPublicClient({ transport: http(MAINNET_RPC, { retryCount: 3 }) }) as never);
  const out: Record<string, string> = {};
  for (const [mock, real] of [["mTSLA", "TSLA"], ["mAAPL", "AAPL"], ["mSPY", "SPY"]] as const) {
    try {
      const f = await reader.read(real);
      out[`TESTNET_PRICE_${mock}`] = mockAnswerFor(f, 8, true).toString();
    } catch (e) {
      log(`real ${real} price not read (${(e as Error).message.split("\n")[0]}): the kit default is used`);
    }
  }
  return out;
}

function forgeEnv(extra: Record<string, string>) {
  return {
    ...process.env,
    TESTNET_KEEPER: role("keeper").address,
    TESTNET_ATTESTER: role("attester").address,
    TESTNET_COMMITTEE: role("deployer").address,
    ...extra,
  };
}

/**
 * Forge simulation of the deploy (no broadcast) + the Orbit L1 data component of its calldata, priced at
 * today's base fee. Returns wei. The L1 part is measured on the largest transaction and applied per byte.
 */
export async function estimateDeploy(prices: Record<string, string>): Promise<{ l2Gas: bigint; l1Gas: bigint; gasPrice: bigint; wei: bigint; txs: number }> {
  await assertTestnet();
  const D = role("deployer").address;
  const r = Bun.spawnSync(
    ["forge", "script", "script/TestnetStack.s.sol:TestnetStack", "--rpc-url", RPC, "--sender", D, "--non-interactive"],
    { cwd: CONTRACTS, env: forgeEnv({ ...prices, TESTNET_STACK_FILE: "estimate-46630.json" }), stdout: "pipe", stderr: "pipe" },
  );
  const out = r.stdout.toString() + r.stderr.toString();
  writeFileSync(join(PATHS.logs, "deploy-estimate.log"), out);
  rmSync(join(PATHS.deployments, "estimate-46630.json"), { force: true });
  if (r.exitCode !== 0) throw new Error(`forge simulation failed (exit ${r.exitCode}); see ${join(PATHS.logs, "deploy-estimate.log")}\n${out.slice(-2000)}`);
  const dry = JSON.parse(readFileSync(join(BROADCAST, "dry-run", "run-latest.json"), "utf8")) as { transactions: { transaction: { input?: Hex; data?: Hex; gas?: Hex; to?: Address | null } }[] };
  let l2Gas = 0n;
  let bytes = 0n;
  let big = dry.transactions[0]!.transaction;
  for (const t of dry.transactions) {
    const data = (t.transaction.input ?? t.transaction.data ?? "0x") as Hex;
    // forge's per-tx gas already carries its 1.3x estimate multiplier: a safe upper bound.
    l2Gas += BigInt(t.transaction.gas ?? "0x0");
    bytes += BigInt((data.length - 2) / 2);
    if ((data.length ?? 0) > ((big.input ?? big.data ?? "0x") as string).length) big = t.transaction;
  }
  const { pub } = clients();
  const bigData = (big.input ?? big.data ?? "0x") as Hex;
  const sim = await pub.simulateContract({ address: nodeInterface, abi: nodeAbi, functionName: "gasEstimateComponents", args: [big.to ? getAddress(big.to) : "0x0000000000000000000000000000000000000000", !big.to, bigData], account: D });
  const [, l1ForBig] = sim.result as readonly [bigint, bigint, bigint, bigint];
  const bigBytes = BigInt((bigData.length - 2) / 2);
  const l1Gas = bigBytes > 0n ? (l1ForBig * bytes) / bigBytes + l1ForBig : 0n;
  const gasPrice = await pub.getGasPrice();
  // Pay up to 2x today's base fee (forge's default max fee); estimate with that so the floor check is safe.
  const wei = (l2Gas + l1Gas) * gasPrice * 2n;
  return { l2Gas, l1Gas, gasPrice, wei, txs: dry.transactions.length };
}

/** ETH the deployer will still send: each role's and each tester's top-up to its target (0 at >= 80%). */
export function fundingNeed(balances: Partial<Record<Role, bigint>>, testerBalances: bigint[]): bigint {
  let need = 0n;
  for (const [r, target] of Object.entries(ETH_TARGETS) as [Role, bigint][]) need += topUpAmount(balances[r] ?? 0n, target);
  for (const b of testerBalances) need += topUpAmount(b, TESTER_ETH);
  return need;
}

/**
 * What the deploy is charged: Orbit charges the base fee (the x2 max fee is only a per-transaction cap, and the
 * deployer needs that cap for one transaction at a time, not for all of them). The L2 gas is forge's 1.3x bound.
 * Measured 2026-10-06: 139.0M gas, 0.00139 ETH at 0.01 gwei.
 */
export function deployCostAtBaseFee(est: { l2Gas: bigint; l1Gas: bigint; gasPrice: bigint }): bigint {
  return (est.l2Gas + est.l1Gas) * est.gasPrice;
}

async function deploy(estimateOnly: boolean) {
  const { pub } = clients();
  const D = role("deployer");
  const prices = await realPrices();
  log(`mock prices (per share, 8 dp): ${JSON.stringify(prices)}`);
  const est = await estimateDeploy(prices);
  // Only what the wallets still need (a redeploy finds them funded), not every target in full.
  const balances: Record<string, bigint> = {};
  for (const r of Object.keys(ETH_TARGETS) as Role[]) balances[r] = await pub.getBalance({ address: role(r).address });
  const testerBalances: bigint[] = [];
  for (const t of testers()) testerBalances.push(await pub.getBalance({ address: t }));
  const plan = fundingNeed(balances, testerBalances);
  const bal = await pub.getBalance({ address: D.address });
  const expected = deployCostAtBaseFee(est);
  const line = `deploy estimate: ${est.txs} txs, L2 ${est.l2Gas} gas (forge 1.3x bound) + L1 data ${est.l1Gas} gas at ${est.gasPrice} wei = ${fmtEth(expected)} ETH (cap at the x2 max fee ${fmtEth(est.wei)}); funding still needed ${fmtEth(plan)} ETH; deployer ${fmtEth(bal)} ETH`;
  log(line);
  writeFileSync(join(TESTNET_DIR, "deploy-estimate.json"), JSON.stringify({ at: new Date().toISOString(), ...Object.fromEntries(Object.entries(est).map(([k, v]) => [k, String(v)])), expectedWei: String(expected), fundingPlanWei: String(plan), deployerWei: String(bal), prices }, null, 2));
  if (!affordable(bal, expected + plan, DEPLOYER_FLOOR)) {
    throw new Error(`budget: ${line} would leave the deployer below ${fmtEth(DEPLOYER_FLOOR)} ETH. Deploy in priority order instead (docs BACKLOG A3).`);
  }
  if (estimateOnly) return;

  await assertTestnet();
  const startBlock = Number(await pub.getBlockNumber());
  log("forge script TestnetStack --broadcast (testnet 46630, keystore plynth-testnet)");
  const r = Bun.spawnSync(
    ["forge", "script", "script/TestnetStack.s.sol:TestnetStack", "--rpc-url", RPC, "--keystore", keystorePath(WALLETS.deployer), "--password-file", passwordFile(WALLETS.deployer), "--sender", D.address, "--broadcast", "--slow", "--non-interactive"],
    { cwd: CONTRACTS, env: forgeEnv(prices), stdout: "pipe", stderr: "pipe" },
  );
  const out = r.stdout.toString() + r.stderr.toString();
  writeFileSync(join(PATHS.logs, "deploy.log"), out);
  if (r.exitCode !== 0) throw new Error(`forge broadcast failed (exit ${r.exitCode}); see ${join(PATHS.logs, "deploy.log")}; rerun with --resume in contracts/ if it stopped halfway\n${out.slice(-3000)}`);
  const run = JSON.parse(readFileSync(join(BROADCAST, "run-latest.json"), "utf8")) as { receipts: { transactionHash: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; contractAddress?: Address | null }[] };
  let fee = 0n;
  let gas = 0n;
  for (const rc of run.receipts) {
    const f = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
    fee += f;
    gas += BigInt(rc.gasUsed);
    appendLedger({ at: new Date().toISOString(), what: "deploy (TestnetStack.s.sol)", from: "deployer", tx: rc.transactionHash, gasUsed: String(BigInt(rc.gasUsed)), feeWei: String(f) });
  }
  const first = run.receipts.map((x) => Number(BigInt(x.blockNumber))).reduce((a, b) => Math.min(a, b), Number.MAX_SAFE_INTEGER);
  fixDeployment(Number.isFinite(first) && first < Number.MAX_SAFE_INTEGER ? first : startBlock + 1);
  log(`deployed: ${run.receipts.length} txs, ${gas} gas, ${fmtEth(fee)} ETH`);
  rmSync(PATHS.state, { force: true });
}

/**
 * Rewrites the script's output into what the services read: deployBlock / treasuryFactoryBlock = the L2 block of
 * the first deploy transaction (forge writes the parent-chain block on Orbit), stocks and perpMarkets as
 * objects, checksummed addresses, and the <chainid>-treasury.json split the API and MCP server merge.
 */
export function fixDeployment(deployBlock: number) {
  const raw = JSON.parse(readFileSync(PATHS.deployment, "utf8")) as Record<string, unknown>;
  const { main, treasury } = normalizeDeployment(raw, deployBlock);
  writeFileSync(PATHS.deployment, deploymentText(main));
  writeFileSync(PATHS.treasuryDeployment, `${JSON.stringify(treasury, null, 2)}\n`);
}

/**
 * The committed file's text. A v4 pool id is 32 bytes and reads like a private key to the public guard, so each
 * pool-id line also carries a sibling note with the guard's `// not-a-key` marker (valid JSON, same line).
 */
export function deploymentText(main: Record<string, unknown>): string {
  return `${JSON.stringify(main, null, 2).replace(/^(\s*"(\w*[pP]oolId)": "0x[0-9a-fA-F]{64}")/gm, '$1, "$2Note": "v4 pool id // not-a-key"')}\n`;
}

export function normalizeDeployment(raw: Record<string, unknown>, deployBlock: number) {
  const obj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  const main: Record<string, unknown> = { ...raw, stocks: obj(raw.stocks), perpMarkets: obj(raw.perpMarkets), deployBlock, treasuryFactoryBlock: deployBlock };
  for (const [k, v] of Object.entries(main)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) main[k] = getAddress(v);
  if (main.chainId !== TESTNET_CHAIN_ID) throw new Error(`deployment file is for chain ${main.chainId}, not ${TESTNET_CHAIN_ID}`);
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

async function sendEth(what: string, to: Address, value: bigint) {
  const { pub, wallet } = clients();
  const D = role("deployer");
  const hash = await wallet(D).sendTransaction({ to, value, account: D, chain: clients().chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`${what}: reverted (${hash})`);
  appendLedger({ at: new Date().toISOString(), what, from: "deployer", to, tx: hash, gasUsed: String(rc.gasUsed), feeWei: String(rc.gasUsed * rc.effectiveGasPrice), valueWei: String(value) });
  log(`${what}: ${fmtEth(value)} ETH -> ${to} (${hash})`);
}

async function call(what: string, from: Role, to: Address, data: Hex) {
  const { pub, wallet, chain } = clients();
  const acct = role(from);
  const hash = await wallet(acct).sendTransaction({ to, data, account: acct, chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`${what}: reverted (${hash})`);
  appendLedger({ at: new Date().toISOString(), what, from, to, tx: hash, gasUsed: String(rc.gasUsed), feeWei: String(rc.gasUsed * rc.effectiveGasPrice) });
  log(`${what} (${hash})`);
}

/** Tops each wallet up to its target; each tester wallet gets ETH (to its target) and mock USDG once. */
async function fund() {
  const { pub } = clients();
  for (const [r, target] of Object.entries(ETH_TARGETS) as [Role, bigint][]) {
    const a = role(r).address;
    const need = topUpAmount(await pub.getBalance({ address: a }), target);
    if (need > 0n) await sendEth(`fund ${r} (${WALLETS[r]})`, a, need);
  }
  const dep = readDeployment()!;
  const usdg = getAddress(dep.usdg);
  for (const t of testers()) {
    const need = topUpAmount(await pub.getBalance({ address: t }), TESTER_ETH);
    if (need > 0n) await sendEth("fund a tester wallet", t, need);
    if ((await pub.readContract({ address: usdg, abi: mintAbi, functionName: "balanceOf", args: [t] })) === 0n) {
      await call(`mint ${TESTER_USDG / 1_000_000n} mUSDG to a tester wallet`, "deployer", usdg, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [t, TESTER_USDG] }));
    }
  }
}

/** runbooks/testnet.md "Feeds are mocks": feeds to the keeper, and its float for pool alignment. */
async function handFeedsToKeeper() {
  const { pub } = clients();
  const dep = readDeployment()!;
  const K = role("keeper").address;
  const D = role("deployer").address;
  for (const [sym, s] of Object.entries(dep.stocks)) {
    const owner = getAddress(await pub.readContract({ address: getAddress(s.feed), abi: mintAbi, functionName: "owner" }));
    if (owner === D) await call(`${sym} feed ownership -> keeper`, "deployer", getAddress(s.feed), encodeFunctionData({ abi: mintAbi, functionName: "transferOwnership", args: [K] }));
  }
  const usdg = getAddress(dep.usdg);
  if ((await pub.readContract({ address: usdg, abi: mintAbi, functionName: "balanceOf", args: [K] })) === 0n) {
    await call("keeper float: 1,000,000 mUSDG", "deployer", usdg, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [K, KEEPER_USDG_FLOAT] }));
  }
  for (const [sym, s] of Object.entries(dep.stocks)) {
    const t = getAddress(s.token);
    if ((await pub.readContract({ address: t, abi: mintAbi, functionName: "balanceOf", args: [K] })) === 0n) {
      await call(`keeper float: 10,000 ${sym}`, "deployer", t, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [K, KEEPER_STOCK_FLOAT] }));
    }
  }
}

function writeEnv(name: string, vars: Record<string, string | number | undefined>) {
  writeFileSync(join(PATHS.env, `${name}.env`), envFileText(vars), { mode: 0o600 });
}

/** KEY=value lines; empty values dropped. Only keystore PATHS and password FILE paths, never a key. */
export function envFileText(vars: Record<string, string | number | undefined>): string {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

/** Signer variables for a service: <PREFIX>_KEYSTORE + <PREFIX>_KEYSTORE_PASSWORD_FILE. */
export const keystoreVars = (prefix: string, r: Role) => ({ [`${prefix}_KEYSTORE`]: keystorePath(WALLETS[r]), [`${prefix}_KEYSTORE_PASSWORD_FILE`]: passwordFile(WALLETS[r]) });

/** One env file per service; up.sh sources it in a subshell from TESTNET_DIR (so app/.env is not loaded). */
export function writeEnvFiles() {
  const s = secrets();
  const db = withDatabase(databaseUrl(), DB_NAME);
  const dep = PATHS.deployments;
  const shared = { DATABASE_URL: db, RHC_TESTNET_RPC_URL: RPC, RHC_MAINNET_RPC_URL: MAINNET_RPC, LOG_LEVEL: "info" };
  const treasury = { ...shared, TREASURY_RPC_URL: RPC, TREASURY_CHAIN_ID: TESTNET_CHAIN_ID, TREASURY_FACTORY: readDeployment()!.treasuryFactory as string, TREASURY_POLL_MS: 1000 };
  const elig = {
    ELIGIBILITY_CHAIN: "testnet",
    ELIGIBILITY_REGISTRY: readDeployment()!.eligibilityRegistry as string,
    ...keystoreVars("ELIGIBILITY", "attester"),
    // The services run on this Mac and are reached through localhost (vite proxy): no IP country. Testnet only.
    ELIGIBILITY_ALLOW_UNKNOWN_IP: 1,
    ELIGIBILITY_IP_LIMIT: 1000,
    ELIGIBILITY_ADDRESS_LIMIT: 100,
    ELIGIBILITY_IP_DB: join(ROOT, "app", "data", "dbip-country-lite.mmdb"),
    ELIGIBILITY_SANCTIONS_CACHE: join(ROOT, "app", "data", "ofac-sdn-addresses.json"),
  };
  // Public RPC: the indexer polls every 4 s and waits 2 confirmations; the keeper passes every 20 s.
  writeEnv("indexer", { ...shared, INDEXER_CHAIN: "testnet", INDEXER_PORT: PORTS.indexer, INDEXER_DEPLOYMENTS_DIR: dep, INDEXER_POLL_MS: 4000, INDEXER_CONFIRMATIONS: 2 });
  writeEnv("keeper", { ...shared, KEEPER_CHAIN: "testnet", KEEPER_PORT: PORTS.keeper, KEEPER_DEPLOYMENTS_DIR: dep, ...keystoreVars("KEEPER", "keeper"), KEEPER_SECRET_KEY: s.keeperSecretKey, KEEPER_INTERVAL_MS: 20_000, SPLIT_PARTS: 2 });
  writeEnv("relayer", { ...shared, RELAYER_CHAIN: "testnet", RELAYER_PORT: PORTS.relayer, RELAYER_DEPLOYMENTS_DIR: dep, ...keystoreVars("RELAYER", "relayer"), RELAYER_IP_LIMIT: 100, RELAYER_STEALTH_LIMIT: 20 });
  writeEnv("api", { ...shared, ...elig, API_CHAIN: "testnet", API_PORT: PORTS.api, API_DEPLOYMENTS_DIR: dep, ROUNDUPS_ENABLED: 1, KEEPER_SECRET_KEY: s.keeperSecretKey, MCP_TOKEN_SECRET: s.mcpTokenSecret });
  writeEnv("eligibility", { ...shared, ...elig, ELIGIBILITY_PORT: PORTS.eligibility });
  writeEnv("mcp", { ...shared, RPC_URL: RPC, MCP_PORT: PORTS.mcp, MCP_TOKEN_SECRET: s.mcpTokenSecret, DEPLOYMENT_JSON: PATHS.deployment });
  writeEnv("treasury-marks", { ...treasury, TREASURY_MARKS_PORT: PORTS["treasury-marks"], TREASURY_MARK_INTERVAL_S: 300 });
  writeEnv("treasury-webhooks", { ...treasury, TREASURY_WEBHOOKS_PORT: PORTS["treasury-webhooks"] });

  // Per-treasury services: only once exercise.ts created a treasury and wrote treasury/services.json.
  // Desk passes every 5 min: testnet desk windows are 2 h, so a pass reveals close to the jittered time.
  const tf = join(PATHS.treasury, "services.json");
  for (const n of ["treasury-desks", "treasury-close", "treasury-risk", "treasury-receipts"]) rmSync(join(PATHS.env, `${n}.env`), { force: true });
  if (existsSync(tf)) {
    const t = JSON.parse(readFileSync(tf, "utf8")) as Record<string, string>;
    const controller = keystoreVars("TREASURY_CONTROLLER", "controller");
    writeEnv("treasury-desks", { ...treasury, TREASURY_DESKS_PORT: PORTS["treasury-desks"], TREASURY_CONFIG: t.desksConfig, TREASURY_DESK_INTERVAL_S: 300, TREASURY_JURY: "off", ...keystoreVars("TREASURY_CASH_DESK", "cashDesk"), ...keystoreVars("TREASURY_EQUITY_DESK", "equityDesk") });
    writeEnv("treasury-close", { ...treasury, ...controller, TREASURY_CLOSE_PORT: PORTS["treasury-close"], TREASURY_PERIOD_CLOSE: t.periodClose, TREASURY_CLOSE_SKIP_RECONCILE: 1 });
    writeEnv("treasury-risk", { ...treasury, ...controller, TREASURY_RISK_PORT: PORTS["treasury-risk"], TREASURY_ACCOUNT: t.account, RISK_INTERVAL_SEC: 300 });
    writeEnv("treasury-receipts", { ...treasury, ...controller, TREASURY_RECEIPTS_PORT: PORTS["treasury-receipts"], TREASURY_RECEIPTS: readDeployment()!.receipts as string });
  }
}

async function main() {
  const estimateOnly = process.argv.includes("--estimate-only");
  ensureDirs();
  await assertTestnet();
  for (const r of Object.keys(WALLETS) as Role[]) role(r); // unlock every keystore up front (fails fast on a bad password file)
  if (!(await deployed())) await deploy(estimateOnly);
  else log("deployment present on testnet: skipping deploy");
  if (estimateOnly) return;
  await fund();
  await handFeedsToKeeper();
  const db = withDatabase(databaseUrl(), DB_NAME);
  if (await createDatabaseIfMissing(db)) log(`created database ${DB_NAME}`);
  await runMigrations(db);
  writeEnvFiles();
  const bal = await clients().pub.getBalance({ address: role("deployer").address });
  log(`deployer balance ${formatEther(bal)} ETH; env files in ${PATHS.env}`);
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error(`[testnet setup] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
