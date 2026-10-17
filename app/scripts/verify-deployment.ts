// Post-deploy verification: reads every Plynth contract named in a deployment file and asserts owners, pending
// owners, role holders, wiring, timers, feeds, pools, caps and risk parameters against the file and the deploy
// script's mainnet values (contracts/script/MainnetBeta.s.sol). Read-only; exits 1 on any FAIL.
//
//   bun run verify:deployment                                   # app/deployments/4663.json on the public RPC
//   bun run verify:deployment --file deployments/fork.json --rpc http://127.0.0.1:8545
//   bun run verify:deployment --strict                          # also FAIL while any two-step hand-over is pending
//   bun run verify:deployment --fail-on-warn                    # also exit 1 on any WARN
//
// Two deployment formats, each checked against its own expectations:
//   v1  the closed beta at block 88,470,046 (no market calendar; OI cap 100%, guard loss bound 200 bps)
//   v2  MainnetBeta.s.sol after the 2026-10-16 audit: the file carries `allowEoaOwner` and `calendarValidUntil`.
//       Adds the NYSE calendar (every closed day and early close, its expiry), perp spreads / fees / minimum hold /
//       minimum liquidation reward / minimum collateral, OI cap 20%, guard loss bound 50 bps, the 19:30 UTC crowd
//       grid, the 14-stock list, and in mainnet mode staleness <= 26 h, MIN_CROWD >= 3 and OWNER a contract
//       (unless the deploy set ALLOW_EOA_OWNER=1).
//
// Status:
//   FAIL  a real mismatch (exit 1).
//   WARN  a step expected to finish after the deploy: a cap or adapter waiting for its 48 h timelock, a feed on hold
//         while the market is closed, a two-step hand-over OWNER has not accepted yet, a holiday table with less
//         than 180 days left.
// --strict mirrors MainnetBeta.verifyDeploymentStrict (review v2 L-20): a pending hand-over (the deployer still owns
// a contract with OWNER as pendingOwner) is a FAIL. The release gate (scripts/mainnet/release-gate.ts) and the daily
// CI job run it. The holiday table (review v2 M-1) is a FAIL with less than 90 days left: an expired table holds
// every price (fails closed), so the daily job must alert first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, keccak256, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex } from "viem";

const DAY = 86_400n;

/** v1 (the deployment at block 88,470,046) and the common base. */
export const MAINNET_BETA_V1 = {
  version: 1 as 1 | 2,
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
};

/** The v2 values, read from contracts/script/MainnetBeta.s.sol (keep in step with its constants). */
export const V2 = {
  /** CROWD_DAY_OFFSET: windows end at 19:30 UTC. */
  crowdDayOffset: 19n * 3600n + 30n * 60n,
  /** DEFAULT_MAX_STALENESS: mainnet mode refuses more. */
  maxStalenessMainnet: 26n * 3600n,
  /** DEFAULT_MIN_CROWD: mainnet mode refuses less. */
  minCrowdMainnet: 3,
  perpOpenSpreadBps: 40n,
  perpTakerFeeBps: 10n,
  perpMakerFeeBps: 6n,
  perpMinHold: 30n * 60n,
  perpMinLiqReward: 1_000_000n, // 1 USDG
  perpMinCollateral: 100_000_000n, // 100 USDG
  /** CALENDAR_VALID_UNTIL: 2029-10-01 00:00 UTC. */
  calendarValidUntil: 1_885_507_200n,
  /** Ops alert (review v2 M-1): FAIL with less than this much holiday table left, WARN below calendarWarnDays. */
  calendarFailDays: 90n,
  calendarWarnDays: 180n,
  sequencerFeed: zeroAddress as Address,
  /** nyseClosedDays(): UTC day numbers, Thanksgiving 2026 to Labor Day 2029. */
  closedDays: [
    20783, 20812, 20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176, 21200, 21235, 21288, 21333, 21354,
    21369, 21431, 21511, 21543, 21550, 21564, 21599, 21638, 21697, 21719, 21734, 21795,
  ],
  /** nyseEarlyCloses(). */
  earlyCloses: [20784, 20811, 21148, 21368, 21512, 21733],
  /** stocks(), in deploy order (EquitySleeve's constructor list). */
  stocks: [
    ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "0x4A1166a659A55625345e9515b32adECea5547C38"],
    ["AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"],
    ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"],
    ["AMZN", "0x12f190a9F9d7D37a250758b26824B97CE941bF54", "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"],
    ["MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74", "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E"],
    ["GOOGL", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "0xF6f373a037c30F0e5010d854385cA89185AE638b"],
    ["META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "0x7C38C00C30BEe9378381E7B6135d7283356D71b1"],
    ["MSTR", "0xec262a75e413fAfD0dF80480274532C79D42da09", "0x396118bdFB181e6240E74D243F266B061c0edc3D"],
    ["SPY", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "0x319724394D3A0e3669269846abE664Cd621f9f6A"],
    ["BABA", "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984"],
    ["COIN", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "0xA3a468A452940B7D6b69991207B508c609a98Ef2"],
    ["CRCL", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a"],
    ["PLTR", "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"],
    ["USO", "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c"],
  ] as [string, Address, Address][],
  /** The four perp markets (TSLA, AAPL, NVDA, SPY). */
  perpSymbols: ["TSLA", "AAPL", "NVDA", "SPY"],
};

export const MAINNET_BETA_V2 = {
  ...MAINNET_BETA_V1,
  version: 2 as 1 | 2,
  perpOiCapBps: 2_000n, // PERP_OI_CAP_BPS (audit PERP-4)
  maxOpLossBps: 50n, // GUARD_MAX_OP_LOSS_BPS
};

export type Expected = typeof MAINNET_BETA_V1;
/** The expectations for the deployment currently recorded in app/deployments/4663.json (v1 until v2 is deployed). */
export const MAINNET_BETA: Expected = MAINNET_BETA_V1;

type Stock = { token: Address; feed: Address; currency0: Address; currency1: Address; fee: number; tickSpacing: number; poolId: Hex };
export type Deployment = Record<string, unknown> & {
  chainId: number;
  fork?: boolean;
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
  allowEoaOwner?: boolean;
  calendarValidUntil?: number;
};

export type Status = "ok" | "WARN" | "FAIL";
export type Check = { status: Status; what: string; detail: string };
/** Reads one view function (human-readable signature) on one contract. */
export type Reader = (address: Address, signature: string, args?: readonly unknown[]) => Promise<unknown>;
export type Options = {
  /** verifyDeploymentStrict: a pending two-step hand-over is a FAIL, not a WARN. */
  strict?: boolean;
  /** Unix seconds for the time-dependent checks (default: the wall clock; the CLI passes the latest block's time). */
  now?: bigint;
  /** Override the expectations (default: by the file's format). */
  expected?: Expected;
  /** The code at an address (the CLI passes eth_getCode): an OWNER whose code is an EIP-7702 delegation designator
   *  (0xef0100 || delegate) is still one private key, so it does not count as a contract (review v3 R3-ORC-2). */
  codeOf?: (a: Address) => Promise<Hex | undefined>;
};

/** EIP-7702 delegation designator: 0xef0100 followed by the 20-byte delegate. */
export function isDelegatedEoaCode(code: Hex | undefined): boolean {
  return !!code && code.toLowerCase().startsWith("0xef0100");
}

/** v2 files carry the fields MainnetBeta.s.sol added after the audit; the v1 file (also `beta: true`) has neither. */
export function deploymentVersion(dep: Record<string, unknown>): 1 | 2 {
  return "calendarValidUntil" in dep || "allowEoaOwner" in dep ? 2 : 1;
}

/** forge writes nested objects as JSON strings in a raw script output; the normalized files have objects. */
export function normalize(raw: Record<string, unknown>): Deployment {
  const obj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return { ...raw, stocks: obj(raw.stocks), ...(raw.perpMarkets !== undefined ? { perpMarkets: obj(raw.perpMarkets) } : {}) } as Deployment;
}

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
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();

/**
 * One two-step admin role (owner/pendingOwner, committee/pendingCommittee), as MainnetBeta._owned: OWNER with
 * nothing pending is ok; the deployer with OWNER pending is the expected state between the deploy and OWNER's
 * accept (WARN, FAIL in strict mode); anything else is a FAIL.
 */
export function handover(what: string, address: Address, cur: Address, pending: Address, owner: Address, deployer: Address, strict: boolean, accept = "acceptOwnership()"): Check {
  if (eq(cur, owner) && eq(pending, zeroAddress)) return { status: "ok", what, detail: `${cur}, nothing pending` };
  if (eq(cur, deployer) && eq(pending, owner))
    return { status: strict ? "FAIL" : "WARN", what, detail: `hand-over pending: the deployer still owns ${address}; OWNER must call ${accept}${strict ? " (strict)" : ""}` };
  return { status: "FAIL", what, detail: `on chain ${cur} with pending ${pending}, expected OWNER ${owner} with nothing pending` };
}

/**
 * The NYSE holiday table's expiry (review v2 M-1 ops alert): after calendarValidUntil the Valuer holds every price
 * until OWNER extends the table (48 h delay). FAIL with less than `failDays` left, WARN with less than `warnDays`.
 */
export function calendarCheck(validUntil: bigint, now: bigint, failDays = V2.calendarFailDays, warnDays = V2.calendarWarnDays): Check {
  const what = "valuer holiday table (calendarValidUntil)";
  const left = validUntil - now;
  const days = left / DAY;
  const extend = "OWNER extends it: Valuer.closeDays / earlyCloseDays for the next years, then setCalendarValidUntil (48 h delay)";
  if (left <= 0n) return { status: "FAIL", what, detail: `expired at ${iso(validUntil)}: every price is on hold; ${extend}` };
  if (left < failDays * DAY) return { status: "FAIL", what, detail: `runs out at ${iso(validUntil)}, ${days} days left (< ${failDays}): ${extend} now` };
  if (left < warnDays * DAY) return { status: "WARN", what, detail: `runs out at ${iso(validUntil)}, ${days} days left (< ${warnDays}): ${extend}` };
  return { status: "ok", what, detail: `valid until ${iso(validUntil)} (${days} days left)` };
}

export async function verifyDeployment(
  dep: Deployment,
  read: Reader,
  codeAt: (a: Address) => Promise<boolean>,
  chainId: number,
  opts: Options = {},
): Promise<Check[]> {
  const version = deploymentVersion(dep);
  const x = opts.expected ?? (version === 2 ? MAINNET_BETA_V2 : MAINNET_BETA_V1);
  const v2 = version === 2;
  const strict = !!opts.strict;
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  const out: Check[] = [];
  const push = (status: Status, what: string, detail = "") => out.push({ status, what, detail });
  const addr = (k: string) => dep[k] as Address | undefined;
  const firstLine = (e: unknown) => (e as Error).message.split("\n")[0] ?? "";
  const expect = async (what: string, a: Address | undefined, sig: string, want: unknown, args?: readonly unknown[]) => {
    if (!a) return push("FAIL", what, "address missing from the deployment file");
    try {
      const got = await read(a, sig, args);
      if (eq(got, want)) push("ok", what, show(got));
      else push("FAIL", what, `on chain ${show(got)}, expected ${show(want)}`);
    } catch (e) {
      push("FAIL", what, `read failed: ${firstLine(e)}`);
    }
  };
  const fileFact = (ok: boolean, what: string, detail: string) => push(ok ? "ok" : "FAIL", what, detail);

  // ---- format, chain and code
  push("ok", "deployment format", v2 ? "v2 (calendarValidUntil / allowEoaOwner present)" : "v1");
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

  // ---- v2 deploy-time pins (MainnetBeta.checkConfig)
  const O = dep.owner;
  if (v2) {
    if (dep.fork === true) push("ok", "OWNER is a contract", "fork mode: not required (dry run)");
    else if ((await codeAt(O)) && opts.codeOf && isDelegatedEoaCode(await opts.codeOf(O))) {
      push(dep.allowEoaOwner === true ? "WARN" : "FAIL", "OWNER is a contract", `OWNER ${O} is an EIP-7702 delegated EOA (one key), not a Safe`);
    } else if (await codeAt(O)) push("ok", "OWNER is a contract", O);
    else if (dep.allowEoaOwner === true) push("WARN", "OWNER is a contract", `OWNER ${O} is an EOA (deployed with ALLOW_EOA_OWNER=1)`);
    else push("FAIL", "OWNER is a contract", `no code at OWNER ${O} and allowEoaOwner is not set`);
    if (dep.fork !== true) {
      fileFact(BigInt(dep.maxStaleness) <= V2.maxStalenessMainnet, "maxStaleness <= 26 h (mainnet)", String(dep.maxStaleness));
      fileFact(dep.minCrowd >= V2.minCrowdMainnet, "MIN_CROWD >= 3 (mainnet)", String(dep.minCrowd));
    }
    const syms = Object.keys(dep.stocks);
    const want = V2.stocks.map(([s]) => s);
    fileFact(syms.length === want.length && want.every((s) => syms.includes(s)), "file stocks == MainnetBeta.stocks()", syms.join(","));
    for (const [sym, tokenAddr, feed] of V2.stocks) {
      const s = dep.stocks[sym];
      if (s && (!eq(s.token, tokenAddr) || !eq(s.feed, feed))) push("FAIL", `${sym}: file token / feed`, `file ${s.token} / ${s.feed}, script ${tokenAddr} / ${feed}`);
    }
    const ms = markets.map(([s]) => s);
    fileFact(ms.length === V2.perpSymbols.length && V2.perpSymbols.every((s) => ms.includes(s)), "file perpMarkets == TSLA, AAPL, NVDA, SPY", ms.join(","));
  }

  // ---- owners: every admin role with OWNER, nothing pending, nothing left with the deployer
  const twoStep = ["stockTokenRegistry", "eligibilityRegistry", "savingsVault", "crowdBuy", "shieldedPool", "shieldedTrade", "perpPool", ...(v2 ? ["valuer", "treasuryFactory"] : [])];
  const oneStep = ["stockRouter", "jitterBeacon", ...(token ? ["feeRouter"] : [])];
  if (eq(O, dep.deployer)) push("FAIL", "owner", "OWNER equals the deployer");
  for (const k of oneStep) await expect(`${k}.owner() == OWNER`, addr(k), "function owner() view returns (address)", O);
  const twoStepCheck = async (what: string, a: Address | undefined, cur: string, pend: string, accept: string) => {
    if (!a) return push("FAIL", what, "address missing from the deployment file");
    try {
      const c = (await read(a, `function ${cur}() view returns (address)`)) as Address;
      const p = (await read(a, `function ${pend}() view returns (address)`)) as Address;
      out.push(handover(what, a, c, p, O, dep.deployer, strict, accept));
    } catch (e) {
      push("FAIL", what, `read failed: ${firstLine(e)}`);
    }
  };
  for (const k of twoStep) await twoStepCheck(`${k} hand-over (owner OWNER, no pendingOwner)`, addr(k), "owner", "pendingOwner", "acceptOwnership()");
  for (const [sym, a] of markets) await twoStepCheck(`perpMarket ${sym} hand-over (owner OWNER, no pendingOwner)`, a, "owner", "pendingOwner", "acceptOwnership()");
  if (v2) await twoStepCheck("templateRegistry hand-over (committee OWNER, no pendingCommittee)", addr("templateRegistry"), "committee", "pendingCommittee", "acceptCommittee()");
  else await expect("templateRegistry.committee() == OWNER", addr("templateRegistry"), "function committee() view returns (address)", O);
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
  if (v2) {
    // The adapter allow-list (registerDesk / addVenue refuse any other code): the shipped shared sleeves are on it.
    for (const k of ["cashSleeve", "equitySleeve"]) {
      await expect(`treasuryFactory.isAdapterAllowed(${k})`, addr("treasuryFactory"), "function isAdapterAllowed(address) view returns (bool)", true, [addr(k)]);
    }
  }
  try {
    const v = (await read(addr("cashSleeve")!, "function vaults() view returns (address[])")) as Address[];
    if (v.length === 1 && eq(v[0], addr("steakUsdg"))) push("ok", "cashSleeve.vaults() == [steakUSDG]", show(v));
    else push("FAIL", "cashSleeve.vaults() == [steakUSDG]", show(v));
  } catch (e) {
    push("FAIL", "cashSleeve.vaults()", firstLine(e));
  }

  // ---- timers and risk parameters (deploy-time immutables)
  await expect("crowdBuy.WINDOW()", addr("crowdBuy"), "function WINDOW() view returns (uint64)", x.crowdWindow);
  await expect("crowdBuy.GENESIS()", addr("crowdBuy"), "function GENESIS() view returns (uint64)", BigInt(dep.genesis));
  if (v2) fileFact((BigInt(dep.genesis) + DAY - V2.crowdDayOffset) % DAY === 0n, "crowd windows end 19:30 UTC", iso(BigInt(dep.genesis)));
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
    push("FAIL", "treasuryFactory.policyImpl()", firstLine(e));
  }
  if (token) {
    await expect("staking.UNBONDING()", addr("staking"), "function UNBONDING() view returns (uint256)", x.unbonding);
    await expect("insurancePool.WITHDRAW_DELAY()", addr("insurancePool"), "function WITHDRAW_DELAY() view returns (uint256)", x.insuranceDelay);
    await expect("insurancePool.feeRouter()", addr("insurancePool"), "function feeRouter() view returns (address)", addr("feeRouter"));
    if (v2) await expect("insurancePool.treasuryFactory()", addr("insurancePool"), "function treasuryFactory() view returns (address)", addr("treasuryFactory"));
  }

  // ---- v2 market calendar (review v2 M-1): on, every NYSE closure and early close marked, no sequencer feed, and
  // the table's expiry: the same value in the file, the script and the chain, with enough of it left.
  if (v2) {
    const valuer = addr("valuer");
    await expect("valuer.marketCalendar()", valuer, "function marketCalendar() view returns (bool)", true);
    fileFact(eq(BigInt(dep.calendarValidUntil ?? 0), V2.calendarValidUntil), "file calendarValidUntil == CALENDAR_VALID_UNTIL", String(dep.calendarValidUntil));
    if (valuer) {
      try {
        const until = (await read(valuer, "function calendarValidUntil() view returns (uint256)")) as bigint;
        if (!eq(until, BigInt(dep.calendarValidUntil ?? 0))) push("FAIL", "valuer.calendarValidUntil() == file", `on chain ${until} (${iso(until)}), file ${dep.calendarValidUntil}`);
        else push("ok", "valuer.calendarValidUntil() == file", `${until}`);
        out.push(calendarCheck(until, now));
      } catch (e) {
        push("FAIL", "valuer.calendarValidUntil()", firstLine(e));
      }
      const marked = async (fn: string, days: number[], label: string) => {
        const missing: number[] = [];
        try {
          for (const d of days) if (!(await read(valuer, `function ${fn}(uint256) view returns (bool)`, [BigInt(d)]))) missing.push(d);
          if (missing.length) push("FAIL", `valuer.${fn}: every NYSE ${label}`, `not marked: ${missing.map((d) => iso(BigInt(d) * DAY).slice(0, 10)).join(", ")}`);
          else push("ok", `valuer.${fn}: every NYSE ${label}`, `${days.length} days`);
        } catch (e) {
          push("FAIL", `valuer.${fn}`, firstLine(e));
        }
      };
      await marked("closedDay", V2.closedDays, "full-day closure");
      await marked("earlyCloseDay", V2.earlyCloses, "early close");
      await expect("valuer.sequencerFeed() unset (none on Robinhood Chain)", valuer, "function sequencerFeed() view returns (address)", V2.sequencerFeed);
    }
  }

  // ---- stock tokens: registry entry, feed, router pool, valuation
  const registry = addr("stockTokenRegistry")!;
  try {
    const listed = ((await read(registry, "function tokens() view returns (address[])")) as Address[]).map((a) => a.toLowerCase());
    const want = Object.values(dep.stocks).map((s) => s.token.toLowerCase());
    const extra = listed.filter((a) => !want.includes(a));
    if (extra.length) push("FAIL", "registry.tokens() has only the file's stocks", `extra: ${extra.join(", ")}`);
    else if (v2 && listed.length !== V2.stocks.length) push("FAIL", "registry.tokens() count", `${listed.length}, expected ${V2.stocks.length}`);
    else push("ok", "registry.tokens() has only the file's stocks", `${listed.length} listed`);
  } catch (e) {
    push("FAIL", "registry.tokens()", firstLine(e));
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
      else if (q.hold) push("WARN", `${sym}: valuer`, `on hold (feed updated ${iso(q.updatedAt)}; market closed?)`);
      else push("ok", `${sym}: valuer`, `$${(Number(q.priceUsdPerToken) / 1e18).toFixed(2)}`);
    } catch (e) {
      push("FAIL", `${sym}: stock checks`, firstLine(e));
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
      push("FAIL", `Hidden Vault cap ${a}`, firstLine(e));
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
    push("FAIL", "shieldedTrade park adapter", firstLine(e));
  }

  // ---- perps: every market listed in the pool, priced by our valuer, OI cap (v2: spreads, fees, guards)
  const perpPool = addr("perpPool");
  try {
    const listed = ((await read(perpPool!, "function markets() view returns (address[])")) as Address[]).map((a) => a.toLowerCase());
    const want = markets.map(([, a]) => a.toLowerCase());
    if (listed.length !== want.length || want.some((a) => !listed.includes(a))) push("FAIL", "perpPool.markets()", `on chain ${show(listed)}, file ${show(want)}`);
    else push("ok", "perpPool.markets()", `${listed.length} markets`);
  } catch (e) {
    push("FAIL", "perpPool.markets()", firstLine(e));
  }
  if (v2) {
    await expect("perpPool.TIMELOCK()", perpPool, "function TIMELOCK() view returns (uint256)", x.timelock);
    await expect("perpPool.depositsOpen()", perpPool, "function depositsOpen() view returns (bool)", true);
    // OWNER registers each treasury's in-house perp venue as a maker (hedges cost spread + maker fee, inside the guard).
    await expect("perpPool.makerRegistrar() == OWNER", perpPool, "function makerRegistrar() view returns (address)", dep.owner);
  }
  for (const [sym, a] of markets) {
    await expect(`perpMarket ${sym}.pool()`, a, "function pool() view returns (address)", perpPool);
    await expect(`perpMarket ${sym}.valuer()`, a, "function valuer() view returns (address)", addr("valuer"));
    await expect(`perpMarket ${sym}.underlying()`, a, "function underlying() view returns (address)", dep.stocks[sym]?.token);
    await expect(`perpMarket ${sym}.oiCapBps()`, a, "function oiCapBps() view returns (uint256)", x.perpOiCapBps);
    if (!v2) continue;
    await expect(`perpPool.isMarket(${sym})`, perpPool, "function isMarket(address) view returns (bool)", true, [a]);
    await expect(`perpMarket ${sym}.retireAt() == 0`, a, "function retireAt() view returns (uint256)", 0n);
    await expect(`perpMarket ${sym}.openSpreadBps()`, a, "function openSpreadBps() view returns (uint256)", V2.perpOpenSpreadBps);
    await expect(`perpMarket ${sym}.minHoldSeconds()`, a, "function minHoldSeconds() view returns (uint256)", V2.perpMinHold);
    await expect(`perpMarket ${sym}.takerFeeBps()`, a, "function takerFeeBps() view returns (uint256)", V2.perpTakerFeeBps);
    await expect(`perpMarket ${sym}.makerFeeBps()`, a, "function makerFeeBps() view returns (uint256)", V2.perpMakerFeeBps);
    await expect(`perpMarket ${sym}.minLiquidationReward()`, a, "function minLiquidationReward() view returns (uint256)", V2.perpMinLiqReward);
    await expect(`perpMarket ${sym}.minCollateral()`, a, "function minCollateral() view returns (uint256)", V2.perpMinCollateral);
    try {
      const dev = (await read(a, "function FEED_DEVIATION_BPS() view returns (uint256)")) as bigint;
      const trip = V2.perpOpenSpreadBps + 2n * V2.perpMakerFeeBps;
      fileFact(trip > dev, `perpMarket ${sym} maker round trip > feed deviation`, `${trip} > ${dev} bps`);
    } catch (e) {
      push("FAIL", `perpMarket ${sym}.FEED_DEVIATION_BPS()`, firstLine(e));
    }
  }
  return out;
}

export type Summary = { ok: number; warn: number; fail: number; total: number };
export function summarize(checks: Check[]): Summary {
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const warn = checks.filter((c) => c.status === "WARN").length;
  return { ok: checks.length - fail - warn, warn, fail, total: checks.length };
}

/** Exit code: 1 on any FAIL, or on any WARN with --fail-on-warn. */
export const exitCode = (s: Summary, failOnWarn: boolean) => (s.fail || (failOnWarn && s.warn) ? 1 : 0);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const file = arg("file") ?? join(import.meta.dir, "..", "deployments", "4663.json");
  const dep = normalize(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  const rpc = arg("rpc") ?? process.env.RHC_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  const strict = process.argv.includes("--strict");
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
  const now = (await c.getBlock()).timestamp;
  const codeOf = async (a: Address) => (await c.getCode({ address: getAddress(a) })) ?? undefined;
  const checks = await verifyDeployment(dep, read, codeAt, await c.getChainId(), { strict, now, codeOf });
  for (const ch of checks) console.log(`${ch.status.padEnd(4)} ${ch.what}${ch.detail ? `  ${ch.detail}` : ""}`);
  const s = summarize(checks);
  console.log(`\n${s.total} checks: ${s.ok} ok, ${s.warn} warn, ${s.fail} fail (v${deploymentVersion(dep)}${strict ? ", strict" : ""}; ${file})`);
  process.exit(exitCode(s, process.argv.includes("--fail-on-warn")));
}
