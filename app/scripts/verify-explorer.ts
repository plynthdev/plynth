// Source verification for a deployment, in two parts.
//
// 1. Bytecode match (read-only, needs only the RPC): checks out the commit that recorded the deployment, builds it
//    with the repo's foundry.toml, and compares every deployed contract's runtime code with the build, masking only
//    immutables and linked library addresses. The Solidity metadata hash at the end of the code covers every source
//    file's hash and the compiler settings, so a match proves the chain runs exactly that source.
// 2. Explorer verification: `forge verify-contract` for every Plynth contract in the deployment file (plus the
//    verifiers, clone implementations and libraries found through them), each with its exact constructor
//    arguments, rebuilt from the deployment file the way MainnetBeta.s.sol passed them. Mainnet uses Sourcify
//    (`--verifier sourcify`; Blockscout's API is behind a Cloudflare challenge and Blockscout reads Sourcify
//    matches; Sourcify's chain list, sourcify.dev/server/chains, marks 4663 supported); the testnet uses its Blockscout. A read-only preflight shows which contracts are verified already.
//    Dry run by default: the commands are printed, nothing is submitted without --submit.
//
//   bun run verify:explorer                       # mainnet 4663: bytecode match + Sourcify preflight + commands
//   bun run verify:explorer --chain 46630         # testnet (Blockscout)
//   bun run verify:explorer --file deployments/fork.json --rpc http://127.0.0.1:16545 --broadcast <run-latest.json>
//                                                 # a fork dry run: builds HEAD, prints the mainnet-equivalent
//                                                 # commands, never submits
//   bun run verify:explorer --submit              # also submits every unverified contract (publishes source)
//   --verifier sourcify|blockscout   override the default
//   --ref <git ref>   source to build (default: the last commit that changed the deployment file; HEAD if untracked)
//   --rpc <url>       RPC (default RHC_MAINNET_RPC_URL / RHC_TESTNET_RPC_URL or the public RPC)
//   --broadcast <f>   forge's run-latest.json for this deploy: every constructor argument string is also checked
//                     against the creation transaction's input (FAIL on any difference)
//
// Exit code: 1 if any bytecode differs, a deployment key has no source mapping, a constructor argument string
// differs from its creation transaction, or a submission fails. The explorer being unreachable is reported, not
// fatal, unless --submit was given.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createPublicClient, encodeAbiParameters, getAddress, http, parseAbi, zeroAddress, type AbiParameter, type Address, type Hex } from "viem";
import { deploymentVersion, MAINNET_BETA_V1, MAINNET_BETA_V2, normalize, V2, type Deployment } from "./verify-deployment";

const SOLC = "0.8.28";
const FORK_CHAIN_ID = 31337;
const EXPLORERS: Record<number, { blockscout: string; rpc: string; rpcEnv: string; verifier: "sourcify" | "blockscout" }> = {
  4663: { blockscout: "https://robinhoodchain.blockscout.com", rpc: "https://rpc.mainnet.chain.robinhood.com", rpcEnv: "RHC_MAINNET_RPC_URL", verifier: "sourcify" },
  46630: { blockscout: "https://explorer.testnet.chain.robinhood.com", rpc: "https://rpc.testnet.chain.robinhood.com", rpcEnv: "RHC_TESTNET_RPC_URL", verifier: "blockscout" },
};

/** Deployment-file key -> source path:contract. */
export const SOURCES: Record<string, string> = {
  stockTokenRegistry: "src/core/StockTokenRegistry.sol:StockTokenRegistry",
  valuer: "src/core/Valuer.sol:Valuer",
  stockRouter: "src/core/StockRouter.sol:StockRouter",
  jitterBeacon: "src/core/JitterBeacon.sol:JitterBeacon",
  eligibilityRegistry: "src/core/EligibilityRegistry.sol:EligibilityRegistry",
  savingsVault: "src/consumer/SavingsVault.sol:SavingsVault",
  crowdBuy: "src/consumer/CrowdBuy.sol:CrowdBuy",
  stealthClaims: "src/consumer/StealthClaims.sol:StealthClaims",
  shieldedPool: "src/consumer/ShieldedPool.sol:ShieldedPool",
  shieldedTrade: "src/consumer/ShieldedTrade.sol:ShieldedTrade",
  thresholdVerifier: "src/consumer/ThresholdVerifier.sol:ThresholdVerifier",
  parkAdapter: "src/consumer/park/ERC4626Park.sol:ERC4626Park",
  policyGuard: "src/treasury/PolicyGuard.sol:PolicyGuard",
  templateRegistry: "src/treasury/TemplateRegistry.sol:TemplateRegistry",
  receipts: "src/treasury/Receipts.sol:Receipts",
  treasuryFactory: "src/treasury/TreasuryFactory.sol:TreasuryFactory",
  cashSleeve: "src/treasury/sleeves/CashSleeve.sol:CashSleeve",
  equitySleeve: "src/treasury/sleeves/EquitySleeve.sol:EquitySleeve",
  perpPool: "src/perps/PerpPool.sol:PerpPool",
  plth: "src/token/PLTH.sol:PLTH",
  staking: "src/token/PlinthStaking.sol:PlinthStaking",
  feeRouter: "src/token/FeeRouter.sol:FeeRouter",
  insurancePool: "src/token/ExceptionInsurancePool.sol:ExceptionInsurancePool",
};
export const PERP_MARKET = "src/perps/PerpMarket.sol:PerpMarket";

/** Address-valued deployment keys that are not Plynth contracts: roles and the chain's own contracts. */
export const NOT_PLYNTH = new Set([
  "deployer", "owner", "keeper", "attester", "relayer", "controller", "cashDesk", "equityDesk", "committee",
  "usdg", "poolManager", "permit2", "multicall3", "erc5564Announcer", "erc6538Registry", "steakUsdg", "parkVault",
]);

/** Contracts deployed inside other deployments (verifiers, clone implementations), found through their getters. */
export const DISCOVERED: [string, string, string][] = [
  ["shieldedPool", "transferVerifier", "src/consumer/verifiers/TransferVerifier.sol:TransferVerifier"],
  ["shieldedPool", "withdrawVerifier", "src/consumer/verifiers/WithdrawVerifier.sol:WithdrawVerifier"],
  ["shieldedTrade", "swapVerifier", "src/consumer/verifiers/SwapVerifier.sol:SwapVerifier"],
  ["shieldedTrade", "settleVerifier", "src/consumer/verifiers/SettleVerifier.sol:SettleVerifier"],
  ["thresholdVerifier", "holdingsVerifier", "src/consumer/verifiers/ThresholdHoldingsVerifier.sol:ThresholdHoldingsVerifier"],
  ["thresholdVerifier", "savingsVerifier", "src/consumer/verifiers/ThresholdSavingsVerifier.sol:ThresholdSavingsVerifier"],
  ["treasuryFactory", "policyImpl", "src/treasury/TreasuryPolicy.sol:TreasuryPolicy"],
  ["treasuryFactory", "accountImpl", "src/treasury/TreasuryAccount.sol:TreasuryAccount"],
  ["treasuryFactory", "closeImpl", "src/treasury/PeriodClose.sol:PeriodClose"],
  ["treasuryFactory", "approvalsImpl", "src/treasury/BoardApprovals.sol:BoardApprovals"],
];

type Ref = { start: number; length: number };
export type Param = AbiParameter & { components?: readonly Param[] };
type Artifact = {
  abi: { type: string; inputs?: Param[] }[];
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, Ref[]>; linkReferences?: Record<string, Record<string, Ref[]>> };
};
/** One contract to verify: `name` is the deployment key ("perpMarket TSLA", "shieldedPool.transferVerifier"). */
export type Target = { name: string; address: Address; id: string; libraries: string[]; args?: Hex; argsNote?: string };

/** The Plynth contracts named directly in a deployment file, and any address key with no source mapping. */
export function targetsOf(dep: Record<string, unknown>): { targets: Target[]; unmapped: string[] } {
  const targets: Target[] = [];
  const unmapped: string[] = [];
  for (const [key, v] of Object.entries(dep)) {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    const id = SOURCES[key];
    if (id) targets.push({ name: key, address: getAddress(v), id, libraries: [] });
    else if (!NOT_PLYNTH.has(key)) unmapped.push(key);
  }
  for (const [sym, a] of Object.entries((dep.perpMarkets as Record<string, string>) ?? {}))
    targets.push({ name: `perpMarket ${sym}`, address: getAddress(a), id: PERP_MARKET, libraries: [] });
  return { targets, unmapped };
}

/** The ABI zero value of a parameter (the clone implementations are deployed with all-zero constructors). */
export function zeroOf(p: Param): unknown {
  const t = p.type;
  const arr = t.match(/^(.*)\[(\d*)\]$/);
  if (arr) return arr[2] === "" ? [] : Array.from({ length: Number(arr[2]) }, () => zeroOf({ ...p, type: arr[1]! }));
  if (t === "tuple") return Object.fromEntries((p.components ?? []).map((c) => [c.name, zeroOf(c)]));
  if (t === "address") return zeroAddress;
  if (t === "bool") return false;
  if (t === "string") return "";
  if (t === "bytes") return "0x";
  if (t.startsWith("bytes")) return `0x${"00".repeat(Number(t.slice(5)))}`;
  return 0n;
}

/** Positional arrays for tuples become objects keyed by component name, recursively (what viem encodes). */
export function shape(p: Param, v: unknown): unknown {
  const arr = p.type.match(/^(.*)\[(\d*)\]$/);
  if (arr) return (v as unknown[]).map((x) => shape({ ...p, type: arr[1]! }, x));
  if (p.type === "tuple" && Array.isArray(v)) return Object.fromEntries((p.components ?? []).map((c, i) => [c.name, shape(c, v[i])]));
  if (p.type === "tuple") return Object.fromEntries((p.components ?? []).map((c) => [c.name, shape(c, (v as Record<string, unknown>)[c.name!])]));
  return v;
}

export type Ctx = { dep: Deployment; discovered: Record<string, Address>; target: Target; param?: Param };
type Resolver = (c: Ctx) => unknown;

/** MainnetBeta._tiers(): the same four tiers as the fork and the testnet (PlinthStaking's constructor). */
const STAKING_TIERS = [
  [0n, [2, false, false, 0]],
  [10_000n * 10n ** 18n, [4, true, false, 1]],
  [100_000n * 10n ** 18n, [8, true, true, 2]],
  [1_000_000n * 10n ** 18n, [16, true, true, 3]],
];

const A = (k: string): Resolver => (c) => {
  const v = c.dep[k];
  if (typeof v !== "string") throw new Error(`${k} missing from the deployment file`);
  return getAddress(v);
};
const D = (k: string): Resolver => (c) => {
  const v = c.discovered[k];
  if (!v) throw new Error(`${k} not discovered`);
  return v;
};
const X = (c: Ctx) => (deploymentVersion(c.dep) === 2 ? MAINNET_BETA_V2 : MAINNET_BETA_V1);
const token = (c: Ctx) => !!c.dep.deployToken;
const ZERO = "*zero*";

/**
 * Constructor arguments by contract and parameter name, as MainnetBeta.s.sol passes them (v1 and v2: by name, so a
 * parameter one version lacks is simply never asked for). A parameter that is not here makes the command fall back
 * to `--guess-constructor-args` (and says so).
 */
export const CONSTRUCTOR: Record<string, Record<string, Resolver> | typeof ZERO> = {
  StockTokenRegistry: { owner_: A("deployer") },
  Valuer: { registry_: A("stockTokenRegistry"), maxStaleness_: (c) => BigInt(c.dep.maxStaleness) },
  StockRouter: { pm: A("poolManager"), registry_: A("stockTokenRegistry"), valuer_: A("valuer"), usdg_: A("usdg"), owner_: A("deployer") },
  JitterBeacon: { keeper_: A("keeper"), owner_: A("owner"), grace_: (c) => X(c).beaconGrace },
  EligibilityRegistry: { owner_: A("owner"), attester_: A("attester") },
  SavingsVault: { usdg_: A("usdg"), permit2_: A("permit2"), registry_: A("stockTokenRegistry"), owner_: A("deployer"), keeper_: A("keeper") },
  CrowdBuy: {
    vault_: A("savingsVault"), router_: A("stockRouter"), beacon_: A("jitterBeacon"), minCrowd_: (c) => c.dep.minCrowd,
    slippageBps_: (c) => Number(X(c).crowdSlippageBps), genesis_: (c) => BigInt(c.dep.genesis), owner_: A("deployer"),
    keeper_: A("keeper"), window_: (c) => X(c).crowdWindow,
  },
  StealthClaims: { crowd_: A("crowdBuy"), announcer_: A("erc5564Announcer"), registry_: A("erc6538Registry") },
  ShieldedPool: { transferVerifier_: D("shieldedPool.transferVerifier"), withdrawVerifier_: D("shieldedPool.withdrawVerifier"), owner_: A("deployer"), capDelay_: (c) => X(c).timelock },
  ShieldedTrade: {
    pool_: A("shieldedPool"), swapVerifier_: D("shieldedTrade.swapVerifier"), settleVerifier_: D("shieldedTrade.settleVerifier"),
    router_: A("stockRouter"), owner_: A("deployer"), adapterDelay_: (c) => X(c).timelock,
  },
  ThresholdVerifier: { pool_: A("shieldedPool"), holdingsVerifier_: D("thresholdVerifier.holdingsVerifier"), savingsVerifier_: D("thresholdVerifier.savingsVerifier") },
  ERC4626Park: { vault_: A("steakUsdg"), usdg: A("usdg") },
  PolicyGuard: { registry_: A("stockTokenRegistry"), valuer_: A("valuer"), maxOpLossBps_: (c) => Number(X(c).maxOpLossBps) },
  TemplateRegistry: { committee_: A("owner"), tiers_: (c) => (token(c) ? A("staking")(c) : zeroAddress) },
  Receipts: {},
  TreasuryFactory: {
    policyImpl_: D("treasuryFactory.policyImpl"), accountImpl_: D("treasuryFactory.accountImpl"), closeImpl_: D("treasuryFactory.closeImpl"),
    approvalsImpl_: D("treasuryFactory.approvalsImpl"), guard_: A("policyGuard"), cash_: A("usdg"),
    feeRecipient_: (c) => (token(c) ? A("feeRouter")(c) : A("owner")(c)), tiers_: (c) => (token(c) ? A("staking")(c) : zeroAddress),
    templates_: A("templateRegistry"),
  },
  CashSleeve: { valuer_: A("valuer"), usdg_: A("usdg"), vaults: (c) => [A("steakUsdg")(c)] },
  // MainnetBeta.stocks() order (v1 deployed its first nine in the same order).
  EquitySleeve: { router_: A("stockRouter"), tokens: (c) => V2.stocks.filter(([s]) => s in c.dep.stocks).map(([s]) => getAddress(c.dep.stocks[s]!.token)) },
  PerpPool: { usdg: A("usdg"), owner_: A("deployer"), redeemCooldown_: (c) => X(c).perpCooldown, timelock_: (c) => X(c).timelock },
  PerpMarket: {
    pool_: A("perpPool"), valuer_: A("valuer"), owner_: A("deployer"),
    underlying_: (c) => {
      const sym = c.target.name.replace(/^perpMarket /, "");
      const s = c.dep.stocks[sym];
      if (!s) throw new Error(`no stock ${sym} for ${c.target.name}`);
      return getAddress(s.token);
    },
  },
  PLTH: { worker_: A("deployer"), treasury_: A("owner"), stakerReserve_: A("owner") },
  PlinthStaking: { plth_: A("plth"), usdg_: A("usdg"), tiers_: () => STAKING_TIERS, unbonding_: (c) => X(c).unbonding },
  ExceptionInsurancePool: { usdg_: A("usdg"), committee_: A("owner"), withdrawDelay_: (c) => X(c).insuranceDelay },
  FeeRouter: {
    usdg_: A("usdg"), plth_: A("plth"), staking_: A("staking"), insurance_: A("insurancePool"), pm: A("poolManager"),
    key: (c) => {
      const usdg = A("usdg")(c) as Address;
      const plth = A("plth")(c) as Address;
      const [c0, c1] = usdg.toLowerCase() < plth.toLowerCase() ? [usdg, plth] : [plth, usdg];
      return [c0, c1, 3000, 60, zeroAddress];
    },
    maxSlippageBps_: () => 100, perPushCap_: () => 200_000_000n, owner_: A("deployer"),
  },
  // Clone implementations: deployed with every constructor argument zero, except the policy's timelock
  // (`new TreasuryPolicy(address(0), none, TIMELOCK)`: TreasuryPolicy.TIMELOCK() is what verify:deployment reads).
  TreasuryPolicy: { board_: () => zeroAddress, initial: (c) => c.param && zeroOf(c.param), timelock_: (c) => X(c).timelock },
  TreasuryAccount: ZERO,
  PeriodClose: ZERO,
  BoardApprovals: ZERO,
};

/**
 * The ABI-encoded constructor arguments of one target, from its artifact's constructor inputs (empty when it has
 * none), or a note saying why they cannot be rebuilt (then the command guesses them from the creation transaction).
 */
export function constructorArgs(target: Target, inputs: readonly Param[] | undefined, ctx: Omit<Ctx, "target">): { args: Hex } | { note: string } {
  if (!inputs || inputs.length === 0) return { args: "0x" };
  const name = target.id.split(":")[1]!;
  const table = CONSTRUCTOR[name];
  if (!table) return { note: `no constructor table for ${name}` };
  try {
    const values = inputs.map((p) => {
      if (table === ZERO) return zeroOf(p);
      const r = table[p.name ?? ""];
      if (!r) throw new Error(`no value for ${name}(${p.name})`);
      return shape(p, r({ ...ctx, target, param: p }));
    });
    return { args: encodeAbiParameters(inputs as AbiParameter[], values) };
  } catch (e) {
    return { note: (e as Error).message.split("\n")[0]! };
  }
}

/** The constructor-argument bytes of a creation transaction: its input after the contract's creation code. */
export function argsFromCreation(input: Hex, creationCode: Hex): Hex {
  return `0x${input.slice(creationCode.length).toLowerCase()}`;
}

/** forge's run-latest.json: contract address -> creation input. */
export function creationInputs(run: { transactions: { transactionType: string; contractAddress?: string | null; transaction: { input?: Hex; data?: Hex } }[] }): Map<string, Hex> {
  const m = new Map<string, Hex>();
  for (const t of run.transactions)
    if (t.transactionType === "CREATE" && t.contractAddress) m.set(t.contractAddress.toLowerCase(), (t.transaction.input ?? t.transaction.data ?? "0x") as Hex);
  return m;
}

/** One `forge verify-contract` command (arguments after `forge`). */
export function verifyCommand(t: Target, chainId: number, verifier: "sourcify" | "blockscout", blockscout: string, rpc: string): string[] {
  const v = verifier === "sourcify" ? ["--verifier", "sourcify"] : ["--verifier", "blockscout", "--verifier-url", `${blockscout}/api/`];
  const ctor = t.args !== undefined ? (t.args === "0x" ? [] : ["--constructor-args", t.args]) : ["--guess-constructor-args", "--rpc-url", rpc];
  return ["verify-contract", t.address, t.id, "--chain", String(chainId), ...v, "--compiler-version", SOLC, ...ctor, "--watch", ...t.libraries.flatMap((l) => ["--libraries", l])];
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const run = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
};

/** Runtime code with immutables and library placeholders zeroed, so build and chain compare byte for byte. */
export function masked(code: Hex, refs: Ref[]): string {
  const b = Buffer.from(code.slice(2), "hex");
  for (const r of refs) b.fill(0, r.start, r.start + r.length);
  return b.toString("hex");
}

export function artifactOf(out: string, id: string): Artifact {
  const [path, name] = id.split(":") as [string, string];
  const file = path.split("/").pop()!;
  return JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8")) as Artifact;
}

function refsOf(a: Artifact): Ref[] {
  const imm = Object.values(a.deployedBytecode.immutableReferences ?? {}).flat();
  const libs = Object.values(a.deployedBytecode.linkReferences ?? {}).flatMap((m) => Object.values(m).flat());
  return [...imm, ...libs];
}

/** Library addresses linked into a deployed contract, read from its on-chain code at the link offsets. */
function linkedLibraries(a: Artifact, chainCode: Hex): string[] {
  const b = Buffer.from(chainCode.slice(2), "hex");
  const out: string[] = [];
  for (const [file, libs] of Object.entries(a.deployedBytecode.linkReferences ?? {}))
    for (const [lib, refs] of Object.entries(libs)) {
      const r = refs[0];
      if (!r) continue;
      out.push(`${file}:${lib}:${getAddress(`0x${b.subarray(r.start, r.start + 20).toString("hex")}`)}`);
    }
  return out;
}

/** Blockscout's view of one address: verified, not verified, or unreachable (Cloudflare challenge, network). */
async function explorerStatus(base: string, address: Address): Promise<"verified" | "unverified" | `unreachable (${string})`> {
  try {
    const r = await fetch(`${base}/api/v2/smart-contracts/${address}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const type = r.headers.get("content-type") ?? "";
    if (!type.includes("json")) return `unreachable (HTTP ${r.status}, ${type.split(";")[0] || "no content type"})`;
    if (r.status === 404) return "unverified";
    const j = (await r.json()) as { is_verified?: boolean };
    return j.is_verified ? "verified" : "unverified";
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
}

async function sourcifyStatus(chainId: number, address: Address): Promise<string> {
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, { signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { match?: string | null };
    return j.match ? `verified (${j.match})` : "unverified";
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
}

if (import.meta.main) {
  const appDir = resolve(import.meta.dir, "..");
  const repo = run("git", ["rev-parse", "--show-toplevel"], appDir);
  const fileArg = arg("file");
  const depPath = fileArg ? (isAbsolute(fileArg) ? fileArg : resolve(appDir, fileArg)) : join(appDir, "deployments", `${arg("chain") ?? 4663}.json`);
  const dep = normalize(JSON.parse(readFileSync(depPath, "utf8")) as Record<string, unknown>);
  const fileChain = Number(dep.chainId);
  const fork = dep.fork === true || fileChain === FORK_CHAIN_ID;
  // A fork file (chain 31337) stands in for mainnet: the commands are the mainnet ones, and never submitted.
  const chainId = fork ? 4663 : Number(arg("chain") ?? fileChain);
  const ex = EXPLORERS[chainId];
  if (!ex) throw new Error(`unknown chain ${chainId}`);
  const verifier = (arg("verifier") ?? ex.verifier) as "sourcify" | "blockscout";
  const submit = process.argv.includes("--submit");
  if (submit && fork) throw new Error("a fork deployment is never submitted to an explorer");
  const depRel = relative(repo, depPath);
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", depRel], { cwd: repo }).status === 0;
  const ref = arg("ref") ?? (tracked ? run("git", ["log", "-1", "--format=%H", "--", depRel], repo) : run("git", ["rev-parse", "HEAD"], repo));
  const rpc = arg("rpc") ?? process.env[ex.rpcEnv] ?? ex.rpc;
  const c = createPublicClient({ transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) });
  const rpcChain = await c.getChainId();
  if (rpcChain !== fileChain) throw new Error(`${rpc} is chain ${rpcChain}, the file is for ${fileChain}`);
  const broadcastPath = arg("broadcast");
  const creations = broadcastPath ? creationInputs(JSON.parse(readFileSync(broadcastPath, "utf8"))) : undefined;

  // ---- targets: every Plynth contract in the file, then what they deployed
  const { targets, unmapped } = targetsOf(dep);
  for (const k of unmapped) console.log(`UNMAPPED ${k}: an address in the deployment file with no source mapping (add it to SOURCES or NOT_PLYNTH)`);
  const discovered: Record<string, Address> = {};
  for (const [owner, getter, id] of DISCOVERED) {
    if (typeof dep[owner] !== "string") continue;
    const a = getAddress((await c.readContract({ address: getAddress(dep[owner] as string), abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })) as Address);
    discovered[`${owner}.${getter}`] = a;
    targets.push({ name: `${owner}.${getter}`, address: a, id, libraries: [] });
  }

  // ---- build the recorded source
  const work = mkdtempSync(join(tmpdir(), "plynth-verify-"));
  run("git", ["worktree", "add", "--detach", work, ref], repo);
  let mismatches = 0;
  let failures = 0;
  let argMismatches = 0;
  try {
    const contracts = join(work, "contracts");
    console.log(`deployment: ${depRel} (v${deploymentVersion(dep)}${fork ? ", fork dry run: commands are the mainnet equivalent" : ""})`);
    console.log(`source: ${ref.slice(0, 12)}; building with solc ${SOLC} ...`);
    run("forge", ["build", "--skip", "test", "--skip", "script"], contracts);
    const out = join(contracts, "out");

    // ---- 1. bytecode match, constructor arguments
    const libs = new Map<string, string>();
    for (const t of targets) {
      const a = artifactOf(out, t.id);
      const code = (await c.getCode({ address: t.address })) ?? "0x";
      t.libraries = linkedLibraries(a, code);
      for (const l of t.libraries) {
        const [file, lib, address] = l.split(":") as [string, string, string];
        libs.set(`${file}:${lib}`, address);
      }
      const ok = code !== "0x" && masked(code, refsOf(a)) === masked(a.deployedBytecode.object.replace(/__\$[0-9a-f]{34}\$__/g, "0".repeat(40)) as Hex, refsOf(a));
      if (!ok) mismatches++;
      const r = constructorArgs(t, a.abi.find((x) => x.type === "constructor")?.inputs, { dep, discovered });
      if ("args" in r) t.args = r.args;
      else t.argsNote = r.note;
      let argCheck = "";
      const input = creations?.get(t.address.toLowerCase());
      if (input && t.args !== undefined) {
        const onChain = argsFromCreation(input, a.bytecode.object);
        const same = onChain === t.args.toLowerCase();
        if (!same) argMismatches++;
        argCheck = same ? "  args = creation tx" : `  ARGS DIFFER from the creation tx: ${onChain}`;
      } else if (creations && t.args !== undefined) argCheck = "  (no creation tx in the broadcast file)";
      const argsShown = t.args === undefined ? `args: guessed (${t.argsNote})` : `args: ${(t.args.length - 2) / 2} bytes`;
      console.log(`${ok ? "match   " : "MISMATCH"} ${t.name.padEnd(32)} ${t.address} ${t.id}  ${argsShown}${argCheck}`);
    }
    for (const [lib, address] of libs) {
      const id = `${lib.split(":")[0]}:${lib.split(":")[1]}`;
      targets.push({ name: `library ${lib.split(":")[1]}`, address: getAddress(address), id, libraries: [], args: "0x" });
      const a = artifactOf(out, id);
      const code = (await c.getCode({ address: getAddress(address) })) ?? "0x";
      // A deployed library starts with PUSH20 <its own address> (call protection); the build has zeros there.
      const refs = [...refsOf(a), { start: 1, length: 20 }];
      const ok = code !== "0x" && masked(code, refs) === masked(a.deployedBytecode.object, refs);
      if (!ok) mismatches++;
      console.log(`${ok ? "match   " : "MISMATCH"} ${`library ${lib.split(":")[1]}`.padEnd(32)} ${address} ${id}`);
    }

    // ---- 2. explorer preflight (read-only) and commands
    console.log(`\nexplorer: ${verifier === "sourcify" ? "https://sourcify.dev (Blockscout shows Sourcify matches)" : ex.blockscout}`);
    const pending: Target[] = [];
    for (const t of targets) {
      const s = fork ? "fork (not on chain 4663)" : verifier === "sourcify" ? await sourcifyStatus(chainId, t.address) : await explorerStatus(ex.blockscout, t.address);
      if (!fork) console.log(`  ${s.padEnd(12)} ${t.name}`);
      if (!s.startsWith("verified")) pending.push(t);
    }
    if (fork) console.log("  preflight skipped: fork addresses do not exist on chain 4663");
    const cmds = pending.map((t) => verifyCommand(t, chainId, verifier, ex.blockscout, rpc));
    console.log(`\n${cmds.length} contract(s) to verify${submit ? "" : " (dry run: pass --submit to run these)"}:`);
    for (const a of cmds) console.log(`  (cd contracts && forge ${a.join(" ")})`);
    if (submit) {
      for (const a of cmds) {
        const r = spawnSync("forge", a, { cwd: contracts, encoding: "utf8", stdio: "inherit" });
        if (r.status !== 0) failures++;
      }
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", work], { cwd: repo });
    if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  }
  const guessed = targets.filter((t) => t.args === undefined).length;
  console.log(
    `\nbytecode: ${targets.length - mismatches}/${targets.length} match the source at ${ref.slice(0, 12)}; constructor args rebuilt for ${targets.length - guessed}/${targets.length}` +
      `${creations ? `, ${argMismatches} differ from their creation tx` : ""}${unmapped.length ? `; ${unmapped.length} unmapped key(s)` : ""}${submit ? `; submissions failed: ${failures}` : ""}`,
  );
  if (mismatches || failures || unmapped.length || argMismatches) process.exit(1);
}
