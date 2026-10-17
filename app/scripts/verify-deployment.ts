// Post-deploy verification: reads every Plynth contract named in a deployment file and asserts owners, pending
// owners, role holders, wiring, timers, feeds, pools, caps and risk parameters against the file and the deploy
// script's mainnet values (contracts/script/MainnetBeta.s.sol). Read-only; exits 1 on any mismatch.
//
//   bun run verify:deployment                                   # app/deployments/4663.json on the public RPC
//   bun run verify:deployment --file deployments/fork.json --rpc http://127.0.0.1:8545
//   bun run verify:deployment --strict                          # also fail on WARN (time-dependent steps)
//
// WARN marks steps that are expected to finish after the deploy (a cap or adapter waiting for its 48 h timelock,
// a feed on hold while the market is closed). FAIL is a real mismatch. After a redeploy with different
// parameters (for example v2), update MAINNET_BETA below in the same commit as the new deployment file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, keccak256, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex } from "viem";

export const MAINNET_BETA = {
  crowdWindow: 24n * 3600n,
  beaconGrace: 3600n,
  timelock: 48n * 3600n, // treasury policy, Hidden Vault caps, park adapter
  unbonding: 7n * 24n * 3600n,
  insuranceDelay: 14n * 24n * 3600n,
  perpCooldown: 24n * 3600n,
  crowdSlippageBps: 100n,
  perpOiCapBps: 10_000n,
  hiddenMinDepositUsdg: 1_000_000n, // 1 USDG
  maxOpLossBps: 200n,
  unlimitedCap: 2n ** 256n - 1n,
} as const;
export type Expected = typeof MAINNET_BETA;

type Stock = { token: Address; feed: Address; currency0: Address; currency1: Address; fee: number; tickSpacing: number; poolId: Hex };
export type Deployment = Record<string, unknown> & {
  chainId: number;
  owner: Address;
  deployer: Address;
  keeper: Address;
  attester: Address;
  deployToken?: boolean;
  maxStaleness: number;
  minCrowd: number;
  genesis: number;
  stocks: Record<string, Stock>;
  perpMarkets?: Record<string, Address>;
};

export type Status = "ok" | "WARN" | "FAIL";
export type Check = { status: Status; what: string; detail: string };
/** Reads one view function (human-readable signature) on one contract. */
export type Reader = (address: Address, signature: string, args?: readonly unknown[]) => Promise<unknown>;

const eq = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.startsWith("0x") && b.startsWith("0x")
    ? a.toLowerCase() === b.toLowerCase()
    : typeof a === "bigint" || typeof b === "bigint"
      ? BigInt(a as bigint) === BigInt(b as bigint)
      : a === b;

/** "applies after <eta>" while the timelock runs; once it has passed, says that anyone can finish it now. */
const pendingNote = (eta: bigint, call: string) =>
  BigInt(Math.floor(Date.now() / 1000)) >= eta
    ? `timelock passed at ${new Date(Number(eta) * 1000).toISOString()}: anyone can call ${call} now`
    : `applies after ${new Date(Number(eta) * 1000).toISOString()} (then anyone calls ${call})`;

const show = (v: unknown) => (typeof v === "bigint" ? v.toString() : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function verifyDeployment(
  dep: Deployment,
  read: Reader,
  codeAt: (a: Address) => Promise<boolean>,
  chainId: number,
  x: Expected = MAINNET_BETA,
): Promise<Check[]> {
  const out: Check[] = [];
  const push = (status: Status, what: string, detail = "") => out.push({ status, what, detail });
  const addr = (k: string) => dep[k] as Address | undefined;
  const expect = async (what: string, a: Address | undefined, sig: string, want: unknown, args?: readonly unknown[]) => {
    if (!a) return push("FAIL", what, "address missing from the deployment file");
    try {
      const got = await read(a, sig, args);
      if (eq(got, want)) push("ok", what, show(got));
      else push("FAIL", what, `on chain ${show(got)}, expected ${show(want)}`);
    } catch (e) {
      push("FAIL", what, `read failed: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  // ---- chain and code
  if (chainId !== dep.chainId) push("FAIL", "chain id", `RPC ${chainId}, file ${dep.chainId}`);
  else push("ok", "chain id", String(chainId));
  const token = !!dep.deployToken;
  const plynth = [
    "stockTokenRegistry", "valuer", "stockRouter", "eligibilityRegistry", "jitterBeacon", "savingsVault", "crowdBuy",
    "stealthClaims", "shieldedPool", "shieldedTrade", "parkAdapter", "thresholdVerifier", "policyGuard",
    "templateRegistry", "receipts", "treasuryFactory", "cashSleeve", "equitySleeve", "perpPool",
    ...(token ? ["plth", "staking", "feeRouter", "insurancePool"] : []),
  ];
  const markets = Object.entries(dep.perpMarkets ?? {});
  for (const k of plynth) {
    const a = addr(k);
    if (!a) push("FAIL", `${k}: address`, "missing from the deployment file");
    else if (!(await codeAt(a))) push("FAIL", `${k}: code`, `no code at ${a}`);
    else push("ok", `${k}: code`, a);
  }
  for (const [sym, a] of markets) {
    if (!(await codeAt(a))) push("FAIL", `perpMarket ${sym}: code`, `no code at ${a}`);
    else push("ok", `perpMarket ${sym}: code`, a);
  }

  // ---- owners: every admin role with OWNER, nothing pending, nothing left with the deployer
  const O = dep.owner;
  const twoStep = ["stockTokenRegistry", "eligibilityRegistry", "savingsVault", "crowdBuy", "shieldedPool", "shieldedTrade", "perpPool"];
  const oneStep = ["stockRouter", "jitterBeacon", ...(token ? ["feeRouter"] : [])];
  if (eq(O, dep.deployer)) push("FAIL", "owner", "OWNER equals the deployer");
  for (const k of [...twoStep, ...oneStep]) await expect(`${k}.owner() == OWNER`, addr(k), "function owner() view returns (address)", O);
  for (const k of twoStep) await expect(`${k}.pendingOwner() == 0 (accepted)`, addr(k), "function pendingOwner() view returns (address)", zeroAddress);
  for (const [sym, a] of markets) {
    await expect(`perpMarket ${sym}.owner() == OWNER`, a, "function owner() view returns (address)", O);
    await expect(`perpMarket ${sym}.pendingOwner() == 0 (accepted)`, a, "function pendingOwner() view returns (address)", zeroAddress);
  }
  await expect("templateRegistry.committee() == OWNER", addr("templateRegistry"), "function committee() view returns (address)", O);
  if (token) await expect("insurancePool.committee() == OWNER", addr("insurancePool"), "function committee() view returns (address)", O);

  // ---- bots
  await expect("eligibilityRegistry.attester() == ATTESTER", addr("eligibilityRegistry"), "function attester() view returns (address)", dep.attester);
  for (const k of ["jitterBeacon", "savingsVault", "crowdBuy", ...(token ? ["feeRouter"] : [])])
    await expect(`${k}.keeper() == KEEPER`, addr(k), "function keeper() view returns (address)", dep.keeper);

  // ---- wiring
  const w = (what: string, k: string, fn: string, target: string) => expect(what, addr(k), `function ${fn}() view returns (address)`, addr(target));
  await w("valuer.registry()", "valuer", "registry", "stockTokenRegistry");
  await w("stockRouter.registry()", "stockRouter", "registry", "stockTokenRegistry");
  await w("stockRouter.valuer()", "stockRouter", "valuer", "valuer");
  await w("stockRouter.usdg()", "stockRouter", "usdg", "usdg");
  await w("stockRouter.poolManager()", "stockRouter", "poolManager", "poolManager");
  await w("savingsVault.crowd()", "savingsVault", "crowd", "crowdBuy");
  await w("savingsVault.eligibility()", "savingsVault", "eligibility", "eligibilityRegistry");
  await w("savingsVault.usdg()", "savingsVault", "usdg", "usdg");
  await w("savingsVault.permit2()", "savingsVault", "permit2", "permit2");
  await w("crowdBuy.vault()", "crowdBuy", "vault", "savingsVault");
  await w("crowdBuy.router()", "crowdBuy", "router", "stockRouter");
  await w("crowdBuy.beacon()", "crowdBuy", "beacon", "jitterBeacon");
  await w("crowdBuy.stealthClaims()", "crowdBuy", "stealthClaims", "stealthClaims");
  await w("crowdBuy.shieldedPool()", "crowdBuy", "shieldedPool", "shieldedPool");
  await w("stealthClaims.crowd()", "stealthClaims", "crowd", "crowdBuy");
  await w("stealthClaims.announcer()", "stealthClaims", "announcer", "erc5564Announcer");
  await w("stealthClaims.registry()", "stealthClaims", "registry", "erc6538Registry");
  await w("shieldedPool.crowd()", "shieldedPool", "crowd", "crowdBuy");
  await w("shieldedPool.trade()", "shieldedPool", "trade", "shieldedTrade");
  await w("shieldedTrade.pool()", "shieldedTrade", "pool", "shieldedPool");
  await w("shieldedTrade.router()", "shieldedTrade", "router", "stockRouter");
  await w("thresholdVerifier.pool()", "thresholdVerifier", "pool", "shieldedPool");
  await w("parkAdapter.vault()", "parkAdapter", "vault", "steakUsdg");
  await w("policyGuard.valuer()", "policyGuard", "valuer", "valuer");
  await w("policyGuard.registry()", "policyGuard", "registry", "stockTokenRegistry");
  await w("treasuryFactory.guard()", "treasuryFactory", "guard", "policyGuard");
  await w("treasuryFactory.templates()", "treasuryFactory", "templates", "templateRegistry");
  await w("treasuryFactory.cash()", "treasuryFactory", "cash", "usdg");
  await w("equitySleeve.router()", "equitySleeve", "router", "stockRouter");
  await w("cashSleeve.valuer()", "cashSleeve", "valuer", "valuer");
  await w("perpPool.asset()", "perpPool", "asset", "usdg");
  await expect("treasuryFactory.feeRecipient()", addr("treasuryFactory"), "function feeRecipient() view returns (address)", token ? addr("feeRouter") : O);
  try {
    const v = (await read(addr("cashSleeve")!, "function vaults() view returns (address[])")) as Address[];
    if (v.length === 1 && eq(v[0], addr("steakUsdg"))) push("ok", "cashSleeve.vaults() == [steakUSDG]", show(v));
    else push("FAIL", "cashSleeve.vaults() == [steakUSDG]", show(v));
  } catch (e) {
    push("FAIL", "cashSleeve.vaults()", (e as Error).message.split("\n")[0]);
  }

  // ---- timers and risk parameters (deploy-time immutables)
  await expect("crowdBuy.WINDOW()", addr("crowdBuy"), "function WINDOW() view returns (uint64)", x.crowdWindow);
  await expect("crowdBuy.GENESIS()", addr("crowdBuy"), "function GENESIS() view returns (uint64)", BigInt(dep.genesis));
  await expect("crowdBuy.MIN_CROWD()", addr("crowdBuy"), "function MIN_CROWD() view returns (uint32)", dep.minCrowd);
  await expect("crowdBuy.slippageBps()", addr("crowdBuy"), "function slippageBps() view returns (uint16)", Number(x.crowdSlippageBps));
  await expect("jitterBeacon.GRACE()", addr("jitterBeacon"), "function GRACE() view returns (uint64)", x.beaconGrace);
  await expect("valuer.maxStaleness()", addr("valuer"), "function maxStaleness() view returns (uint256)", BigInt(dep.maxStaleness));
  await expect("shieldedPool.CAP_DELAY()", addr("shieldedPool"), "function CAP_DELAY() view returns (uint256)", x.timelock);
  await expect("shieldedTrade.ADAPTER_DELAY()", addr("shieldedTrade"), "function ADAPTER_DELAY() view returns (uint256)", x.timelock);
  await expect("perpPool.REDEEM_COOLDOWN()", addr("perpPool"), "function REDEEM_COOLDOWN() view returns (uint256)", x.perpCooldown);
  await expect("policyGuard.maxOpLossBps()", addr("policyGuard"), "function maxOpLossBps() view returns (uint256)", x.maxOpLossBps);
  try {
    const impl = (await read(addr("treasuryFactory")!, "function policyImpl() view returns (address)")) as Address;
    await expect("treasury policy TIMELOCK()", impl, "function TIMELOCK() view returns (uint256)", x.timelock);
  } catch (e) {
    push("FAIL", "treasuryFactory.policyImpl()", (e as Error).message.split("\n")[0]);
  }
  if (token) {
    await expect("staking.UNBONDING()", addr("staking"), "function UNBONDING() view returns (uint256)", x.unbonding);
    await expect("insurancePool.WITHDRAW_DELAY()", addr("insurancePool"), "function WITHDRAW_DELAY() view returns (uint256)", x.insuranceDelay);
    await expect("insurancePool.feeRouter()", addr("insurancePool"), "function feeRouter() view returns (address)", addr("feeRouter"));
  }

  // ---- stock tokens: registry entry, feed, router pool, valuation
  const registry = addr("stockTokenRegistry")!;
  try {
    const listed = ((await read(registry, "function tokens() view returns (address[])")) as Address[]).map((a) => a.toLowerCase());
    const want = Object.values(dep.stocks).map((s) => s.token.toLowerCase());
    const extra = listed.filter((a) => !want.includes(a));
    if (extra.length) push("FAIL", "registry.tokens() has only the file's stocks", `extra: ${extra.join(", ")}`);
    else push("ok", "registry.tokens() has only the file's stocks", `${listed.length} listed`);
  } catch (e) {
    push("FAIL", "registry.tokens()", (e as Error).message.split("\n")[0]);
  }
  for (const [sym, s] of Object.entries(dep.stocks)) {
    try {
      const e = (await read(registry, "function entry(address) view returns ((address feed, bool multiplierEmbedded, bool active))", [s.token])) as {
        feed: Address; multiplierEmbedded: boolean; active: boolean;
      };
      if (!e.active) push("FAIL", `${sym}: registry entry`, "not active");
      else if (!eq(e.feed, s.feed)) push("FAIL", `${sym}: registry feed`, `on chain ${e.feed}, file ${s.feed}`);
      else if (!e.multiplierEmbedded) push("FAIL", `${sym}: registry multiplierEmbedded`, "false (mainnet feeds price one token)");
      else push("ok", `${sym}: registry entry`, `feed ${e.feed}`);

      const k = (await read(addr("stockRouter")!, "function poolOf(address) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))", [s.token])) as {
        currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address;
      };
      const id = keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
      ));
      if (!eq(k.hooks, zeroAddress)) push("FAIL", `${sym}: router pool hooks`, `hooked pool ${k.hooks}`);
      else if (!eq(k.currency0, s.currency0) || !eq(k.currency1, s.currency1) || k.fee !== s.fee || k.tickSpacing !== s.tickSpacing)
        push("FAIL", `${sym}: router pool key`, `on chain ${show(k)}, file ${show({ currency0: s.currency0, currency1: s.currency1, fee: s.fee, tickSpacing: s.tickSpacing })}`);
      else if (!eq(id, s.poolId)) push("FAIL", `${sym}: router pool id`, `${id} != ${s.poolId}`);
      else push("ok", `${sym}: router pool`, `fee ${k.fee} tickSpacing ${k.tickSpacing}`);

      const q = (await read(addr("valuer")!, "function quote(address) view returns ((uint256 priceUsdPerToken, uint256 multiplier, uint80 roundId, uint256 updatedAt, bool hold))", [s.token])) as {
        priceUsdPerToken: bigint; hold: boolean; updatedAt: bigint;
      };
      if (q.priceUsdPerToken === 0n) push("FAIL", `${sym}: valuer price`, "zero");
      else if (q.hold) push("WARN", `${sym}: valuer`, `on hold (feed updated ${new Date(Number(q.updatedAt) * 1000).toISOString()}; market closed?)`);
      else push("ok", `${sym}: valuer`, `$${(Number(q.priceUsdPerToken) / 1e18).toFixed(2)}`);
    } catch (e) {
      push("FAIL", `${sym}: stock checks`, (e as Error).message.split("\n")[0]);
    }
  }

  // ---- Hidden Vault: no pause, minimum deposit, caps (proposed unlimited; applied after the timelock), park adapter
  const pool = addr("shieldedPool")!;
  await expect("shieldedPool.depositsPaused() == false", pool, "function depositsPaused() view returns (bool)", false);
  await expect("shieldedPool.minDeposit(USDG)", pool, "function minDeposit(address) view returns (uint256)", x.hiddenMinDepositUsdg, [addr("usdg")]);
  const hiddenAssets = [addr("usdg")!, addr("steakUsdg")!, ...Object.values(dep.stocks).map((s) => s.token)];
  for (const a of hiddenAssets) {
    try {
      const cap = (await read(pool, "function cap(address) view returns (uint256)", [a])) as bigint;
      const [pCap, eta] = (await read(pool, "function capProposal(address) view returns (uint256, uint64)", [a])) as [bigint, bigint];
      if (cap === x.unlimitedCap) push("ok", `Hidden Vault cap ${a}`, "unlimited");
      else if (pCap === x.unlimitedCap) push("WARN", `Hidden Vault cap ${a}`, `unlimited cap proposed; ${pendingNote(eta, "applyCap(asset)")}`);
      else push("FAIL", `Hidden Vault cap ${a}`, `cap ${cap}, proposal ${pCap}`);
    } catch (e) {
      push("FAIL", `Hidden Vault cap ${a}`, (e as Error).message.split("\n")[0]);
    }
  }
  try {
    const trade = addr("shieldedTrade")!;
    const share = addr("steakUsdg")!;
    const adapter = (await read(trade, "function adapterOf(address) view returns (address)", [share])) as Address;
    if (eq(adapter, addr("parkAdapter"))) push("ok", "shieldedTrade park adapter", adapter);
    else {
      const [p, eta] = (await read(trade, "function adapterProposal(address) view returns (address, uint64)", [share])) as [Address, bigint];
      if (eq(p, addr("parkAdapter"))) push("WARN", "shieldedTrade park adapter", `proposed; ${pendingNote(eta, "applyAdapter(steakUSDG)")}`);
      else push("FAIL", "shieldedTrade park adapter", `adapterOf ${adapter}, proposal ${p}`);
    }
  } catch (e) {
    push("FAIL", "shieldedTrade park adapter", (e as Error).message.split("\n")[0]);
  }

  // ---- perps: every market listed in the pool, priced by our valuer, OI cap
  try {
    const listed = ((await read(addr("perpPool")!, "function markets() view returns (address[])")) as Address[]).map((a) => a.toLowerCase());
    const want = markets.map(([, a]) => a.toLowerCase());
    if (listed.length !== want.length || want.some((a) => !listed.includes(a))) push("FAIL", "perpPool.markets()", `on chain ${show(listed)}, file ${show(want)}`);
    else push("ok", "perpPool.markets()", `${listed.length} markets`);
  } catch (e) {
    push("FAIL", "perpPool.markets()", (e as Error).message.split("\n")[0]);
  }
  for (const [sym, a] of markets) {
    await expect(`perpMarket ${sym}.pool()`, a, "function pool() view returns (address)", addr("perpPool"));
    await expect(`perpMarket ${sym}.valuer()`, a, "function valuer() view returns (address)", addr("valuer"));
    await expect(`perpMarket ${sym}.underlying()`, a, "function underlying() view returns (address)", dep.stocks[sym]?.token);
    await expect(`perpMarket ${sym}.oiCapBps()`, a, "function oiCapBps() view returns (uint256)", x.perpOiCapBps);
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const file = arg("file") ?? join(import.meta.dir, "..", "deployments", "4663.json");
  const dep = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  const rpc = arg("rpc") ?? process.env.RHC_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  const c = createPublicClient({ transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) });
  const read: Reader = (address, signature, args) => {
    const abi = parseAbi([signature]);
    const functionName = (abi[0] as { name: string }).name;
    return c.readContract({ address: getAddress(address), abi, functionName, args: args as never }) as Promise<unknown>;
  };
  const codeAt = async (a: Address) => {
    const code = await c.getCode({ address: getAddress(a) });
    return !!code && code !== "0x";
  };
  const checks = await verifyDeployment(dep, read, codeAt, await c.getChainId());
  for (const ch of checks) console.log(`${ch.status.padEnd(4)} ${ch.what}${ch.detail ? `  ${ch.detail}` : ""}`);
  const fails = checks.filter((c) => c.status === "FAIL").length;
  const warns = checks.filter((c) => c.status === "WARN").length;
  console.log(`\n${checks.length} checks: ${checks.length - fails - warns} ok, ${warns} warn, ${fails} fail (${file})`);
  if (fails || (warns && process.argv.includes("--strict"))) process.exit(1);
}
