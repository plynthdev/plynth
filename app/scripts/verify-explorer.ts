// Source verification for a deployment, in two parts.
//
// 1. Bytecode match (read-only, needs only the RPC): checks out the commit that recorded the deployment, builds it
//    with the repo's foundry.toml, and compares every deployed contract's runtime code with the build, masking only
//    immutables and linked library addresses. The Solidity metadata hash at the end of the code covers every source
//    file's hash and the compiler settings, so a match proves the chain runs exactly that source.
// 2. Explorer verification (Robinhood Chain Blockscout, `forge verify-contract --verifier blockscout`): a read-only
//    preflight that the explorer API answers and which contracts it already shows as verified, then the exact
//    forge commands. They are only run with --submit.
//
//   bun run verify:explorer                       # mainnet 4663: bytecode match + explorer preflight + commands
//   bun run verify:explorer --chain 46630         # testnet
//   bun run verify:explorer --submit              # also submits every unverified contract (publishes source)
//   bun run verify:explorer --verifier sourcify   # Sourcify instead (Blockscout reads Sourcify matches too)
//   --ref <git ref>  source to build (default: the last commit that changed app/deployments/<chain>.json)
//   --rpc <url>      RPC (default RHC_MAINNET_RPC_URL / RHC_TESTNET_RPC_URL or the public RPC)
//
// Exit code: 1 if any bytecode differs or a submission fails; the explorer being unreachable is reported, not fatal,
// unless --submit was given.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";

const SOLC = "0.8.28";
const EXPLORERS: Record<number, { blockscout: string; rpc: string; rpcEnv: string }> = {
  4663: { blockscout: "https://robinhoodchain.blockscout.com", rpc: "https://rpc.mainnet.chain.robinhood.com", rpcEnv: "RHC_MAINNET_RPC_URL" },
  46630: { blockscout: "https://explorer.testnet.chain.robinhood.com", rpc: "https://rpc.testnet.chain.robinhood.com", rpcEnv: "RHC_TESTNET_RPC_URL" },
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

/** Contracts deployed inside other deployments (verifiers, clone implementations), found through their getters. */
const DISCOVERED: [string, string, string][] = [
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
type Artifact = {
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, Ref[]>; linkReferences?: Record<string, Record<string, Ref[]>> };
};
export type Target = { name: string; address: Address; id: string; libraries: string[] };

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
  const chainId = Number(arg("chain") ?? 4663);
  const ex = EXPLORERS[chainId];
  if (!ex) throw new Error(`unknown chain ${chainId}`);
  const verifier = arg("verifier") ?? "blockscout";
  const submit = process.argv.includes("--submit");
  const appDir = resolve(import.meta.dir, "..");
  const repo = run("git", ["rev-parse", "--show-toplevel"], appDir);
  const depRel = `app/deployments/${chainId}.json`;
  const dep = JSON.parse(readFileSync(join(repo, depRel), "utf8")) as Record<string, unknown>;
  const ref = arg("ref") ?? run("git", ["log", "-1", "--format=%H", "--", depRel], repo);
  const rpc = arg("rpc") ?? process.env[ex.rpcEnv] ?? ex.rpc;
  const c = createPublicClient({ transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) });
  if ((await c.getChainId()) !== chainId) throw new Error(`${rpc} is not chain ${chainId}`);

  // ---- targets
  const targets: Target[] = [];
  for (const [key, id] of Object.entries(SOURCES)) if (typeof dep[key] === "string") targets.push({ name: key, address: getAddress(dep[key] as string), id, libraries: [] });
  for (const [sym, a] of Object.entries((dep.perpMarkets as Record<string, string>) ?? {}))
    targets.push({ name: `perpMarket ${sym}`, address: getAddress(a), id: "src/perps/PerpMarket.sol:PerpMarket", libraries: [] });
  for (const [owner, getter, id] of DISCOVERED) {
    if (typeof dep[owner] !== "string") continue;
    const a = (await c.readContract({ address: getAddress(dep[owner] as string), abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })) as Address;
    targets.push({ name: `${owner}.${getter}`, address: getAddress(a), id, libraries: [] });
  }

  // ---- build the recorded source
  const work = mkdtempSync(join(tmpdir(), "plynth-verify-"));
  run("git", ["worktree", "add", "--detach", work, ref], repo);
  let mismatches = 0;
  let failures = 0;
  try {
    const contracts = join(work, "contracts");
    console.log(`source: ${ref.slice(0, 12)} (${depRel}); building with solc ${SOLC} ...`);
    run("forge", ["build", "--skip", "test", "--skip", "script"], contracts);
    const out = join(contracts, "out");

    // ---- 1. bytecode match
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
      console.log(`${ok ? "match   " : "MISMATCH"} ${t.name.padEnd(30)} ${t.address} ${t.id}`);
    }
    for (const [lib, address] of libs) {
      const id = `${lib.split(":")[0]}:${lib.split(":")[1]}`;
      targets.push({ name: `library ${lib.split(":")[1]}`, address: getAddress(address), id, libraries: [] });
      const a = artifactOf(out, id);
      const code = (await c.getCode({ address: getAddress(address) })) ?? "0x";
      // A deployed library starts with PUSH20 <its own address> (call protection); the build has zeros there.
      const refs = [...refsOf(a), { start: 1, length: 20 }];
      const ok = code !== "0x" && masked(code, refs) === masked(a.deployedBytecode.object, refs);
      if (!ok) mismatches++;
      console.log(`${ok ? "match   " : "MISMATCH"} ${`library ${lib.split(":")[1]}`.padEnd(30)} ${address} ${id}`);
    }

    // ---- 2. explorer preflight (read-only) and commands
    console.log(`\nexplorer: ${verifier === "sourcify" ? "https://sourcify.dev" : ex.blockscout}`);
    const pending: Target[] = [];
    for (const t of targets) {
      const s = verifier === "sourcify" ? await sourcifyStatus(chainId, t.address) : await explorerStatus(ex.blockscout, t.address);
      console.log(`  ${s.padEnd(12)} ${t.name}`);
      if (!s.startsWith("verified")) pending.push(t);
    }
    const verifierArgs = verifier === "sourcify"
      ? ["--verifier", "sourcify"]
      : ["--verifier", "blockscout", "--verifier-url", `${ex.blockscout}/api/`];
    const cmds = pending.map((t) => [
      "verify-contract", t.address, t.id, "--chain", String(chainId), ...verifierArgs, "--compiler-version", SOLC,
      "--guess-constructor-args", "--rpc-url", rpc, "--watch", ...t.libraries.flatMap((l) => ["--libraries", l]),
    ]);
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
  console.log(`\nbytecode: ${targets.length - mismatches}/${targets.length} match the source at ${ref.slice(0, 12)}${submit ? `; submissions failed: ${failures}` : ""}`);
  if (mismatches || failures) process.exit(1);
}
