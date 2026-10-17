// The post-deploy check fails closed: a wrong chain, an owner left with the deployer, an unreadable contract or a
// holiday table about to run out is a FAIL, never an ok. A pending two-step hand-over is a WARN, and a FAIL in
// strict mode (MainnetBeta.verifyDeploymentStrict). No chain needed: the readers are stubs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import {
  calendarCheck, deploymentVersion, exitCode, handover, isDelegatedEoaCode, MAINNET_BETA_V1, MAINNET_BETA_V2, normalize, summarize, V2, verifyDeployment,
  type Check, type Deployment, type Reader,
} from "./verify-deployment";

const v1 = JSON.parse(readFileSync(join(import.meta.dir, "..", "deployments", "4663.json"), "utf8")) as Deployment;
const hasCode = async () => true;
const fails = (checks: Check[], what: RegExp) => checks.filter((c) => c.status === "FAIL" && what.test(c.what));
const warns = (checks: Check[], what: RegExp) => checks.filter((c) => c.status === "WARN" && what.test(c.what));
const DAY = 86_400n;
const A1 = getAddress("0x00000000000000000000000000000000000000a1");
const A2 = getAddress("0x00000000000000000000000000000000000000a2");
const A3 = getAddress("0x00000000000000000000000000000000000000a3");
const NOW = 1_792_108_800n; // 2026-10-16 (any time well before the table's end)

/** Answers owner() / pendingOwner() / keeper() as given, and throws on everything else. */
const stub = (dep: Deployment, owner: Address, pending: Address): Reader => async (_a, sig) => {
  if (sig.includes(" owner()") || sig.includes(" committee()")) return owner;
  if (sig.includes("pendingOwner()") || sig.includes("pendingCommittee()")) return pending;
  if (sig.includes("keeper()")) return dep.keeper;
  throw new Error("not stubbed");
};

/** A v2 deployment file: the v1 addresses plus the 14 stocks and the fields MainnetBeta.s.sol now writes. */
function v2File(over: Partial<Deployment> = {}): Deployment {
  const usdg = v1.usdg as Address;
  const stocks: Deployment["stocks"] = {};
  V2.stocks.forEach(([sym, token, feed], i) => {
    const [currency0, currency1] = usdg.toLowerCase() < token.toLowerCase() ? [usdg, token] : [token, usdg];
    const fee = 3000 + i;
    const tickSpacing = 60;
    const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [currency0, currency1, fee, tickSpacing, zeroAddress]));
    stocks[sym] = { token, feed, currency0, currency1, fee, tickSpacing, poolId };
  });
  // genesis on the 19:30 UTC grid
  const genesis = Number(NOW - ((NOW + DAY - V2.crowdDayOffset) % DAY));
  return { ...v1, stocks, genesis, allowEoaOwner: false, calendarValidUntil: Number(V2.calendarValidUntil), ...over } as Deployment;
}

/** The whole chain as a v2 deploy leaves it after OWNER's accepts (caps applied, feeds live). Tweak with `over`. */
function world(dep: Deployment, over: Record<string, unknown> = {}): Reader {
  const a = (k: string) => getAddress(dep[k] as string);
  const keyOf = new Map<string, string>();
  for (const [k, v] of Object.entries(dep)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !keyOf.has(v.toLowerCase())) keyOf.set(v.toLowerCase(), k);
  const markets = Object.entries(dep.perpMarkets ?? {});
  for (const [sym, m] of markets) keyOf.set(m.toLowerCase(), `perp:${sym}`);
  const policyImpl = getAddress("0x00000000000000000000000000000000000000a1");
  keyOf.set(policyImpl.toLowerCase(), "policyImpl");
  const wiring: Record<string, string> = {
    "valuer.registry": "stockTokenRegistry", "stockRouter.registry": "stockTokenRegistry", "stockRouter.valuer": "valuer",
    "stockRouter.usdg": "usdg", "stockRouter.poolManager": "poolManager", "savingsVault.crowd": "crowdBuy",
    "savingsVault.eligibility": "eligibilityRegistry", "savingsVault.usdg": "usdg", "savingsVault.permit2": "permit2",
    "crowdBuy.vault": "savingsVault", "crowdBuy.router": "stockRouter", "crowdBuy.beacon": "jitterBeacon",
    "crowdBuy.stealthClaims": "stealthClaims", "crowdBuy.shieldedPool": "shieldedPool", "stealthClaims.crowd": "crowdBuy",
    "stealthClaims.announcer": "erc5564Announcer", "stealthClaims.registry": "erc6538Registry", "shieldedPool.crowd": "crowdBuy",
    "shieldedPool.trade": "shieldedTrade", "shieldedTrade.pool": "shieldedPool", "shieldedTrade.router": "stockRouter",
    "thresholdVerifier.pool": "shieldedPool", "parkAdapter.vault": "steakUsdg", "policyGuard.valuer": "valuer",
    "policyGuard.registry": "stockTokenRegistry", "treasuryFactory.guard": "policyGuard", "treasuryFactory.templates": "templateRegistry",
    "treasuryFactory.cash": "usdg", "equitySleeve.router": "stockRouter", "cashSleeve.valuer": "valuer", "perpPool.asset": "usdg",
  };
  const x = deploymentVersion(dep) === 2 ? MAINNET_BETA_V2 : MAINNET_BETA_V1;
  return async (address, sig, args) => {
    const fn = sig.match(/function (\w+)\(/)![1]!;
    const k = keyOf.get(address.toLowerCase()) ?? "?";
    const id = `${k.startsWith("perp:") ? "perpMarket" : k}.${fn}`;
    if (id in over) return over[id];
    if (fn in over) return over[fn];
    if (wiring[id]) return a(wiring[id]!);
    switch (fn) {
      case "owner": case "committee": return dep.owner;
      case "pendingOwner": case "pendingCommittee": return zeroAddress;
      case "keeper": return dep.keeper;
      case "attester": return dep.attester;
      case "feeRecipient": return dep.owner;
      case "vaults": return [a("steakUsdg")];
      case "WINDOW": return x.crowdWindow;
      case "GENESIS": return BigInt(dep.genesis);
      case "MIN_CROWD": return dep.minCrowd;
      case "slippageBps": return Number(x.crowdSlippageBps);
      case "GRACE": return x.beaconGrace;
      case "maxStaleness": return BigInt(dep.maxStaleness);
      case "CAP_DELAY": case "ADAPTER_DELAY": case "TIMELOCK": return x.timelock;
      case "REDEEM_COOLDOWN": return x.perpCooldown;
      case "maxOpLossBps": return x.maxOpLossBps;
      case "policyImpl": return policyImpl;
      case "marketCalendar": return true;
      case "calendarValidUntil": return BigInt(dep.calendarValidUntil ?? 0);
      case "closedDay": return V2.closedDays.includes(Number(args![0]));
      case "earlyCloseDay": return V2.earlyCloses.includes(Number(args![0]));
      case "sequencerFeed": return zeroAddress;
      case "tokens": return Object.values(dep.stocks).map((s) => s.token);
      case "entry": {
        const s = Object.values(dep.stocks).find((s) => s.token.toLowerCase() === String(args![0]).toLowerCase())!;
        return { feed: s.feed, multiplierEmbedded: true, active: true };
      }
      case "poolOf": {
        const s = Object.values(dep.stocks).find((s) => s.token.toLowerCase() === String(args![0]).toLowerCase())!;
        return { currency0: s.currency0, currency1: s.currency1, fee: s.fee, tickSpacing: s.tickSpacing, hooks: zeroAddress };
      }
      case "quote": return { priceUsdPerToken: 100n * 10n ** 18n, hold: false, updatedAt: NOW };
      case "depositsPaused": return false;
      case "minDeposit": return x.hiddenMinDepositUsdg;
      case "cap": return x.unlimitedCap;
      case "capProposal": return [0n, 0n];
      case "adapterOf": return a("parkAdapter");
      case "markets": return markets.map(([, m]) => m);
      case "depositsOpen": case "isMarket": case "isAdapterAllowed": return true;
      case "codehashOf": return keccak256(String(args![0]).toLowerCase() as Hex);
      case "allowedHashes": return [keccak256(a("cashSleeve").toLowerCase() as Hex), keccak256(a("equitySleeve").toLowerCase() as Hex)];
      case "makerRegistrar": return dep.owner;
      case "pool": return a("perpPool");
      case "valuer": return a("valuer");
      case "underlying": return dep.stocks[k.slice(5)]!.token;
      case "oiCapBps": return x.perpOiCapBps;
      case "retireAt": return 0n;
      case "openSpreadBps": return V2.perpOpenSpreadBps;
      case "minHoldSeconds": return V2.perpMinHold;
      case "takerFeeBps": return V2.perpTakerFeeBps;
      case "makerFeeBps": return V2.perpMakerFeeBps;
      case "minLiquidationReward": return V2.perpMinLiqReward;
      case "minCollateral": return V2.perpMinCollateral;
      case "FEED_DEVIATION_BPS": return 50n;
      case "offHoursSpreadBps": return V2.perpOffHoursSpreadBps;
      case "borrowBpsPerHour": return V2.perpBorrowBpsPerHour;
      case "fundingK": return V2.perpFundingK;
      case "maxProfitBps": return V2.perpMaxProfitBps;
      case "liquidationFee": return V2.perpLiquidationFee;
      case "getThreshold": return 2n; // OWNER: a 2-of-3 Safe
      case "getOwners": return [A1, A2, A3];
    }
    throw new Error(`not stubbed: ${id}`);
  };
}
/** OWNER is a contract (a Safe); everything else has code too. */
const codeAll = async () => true;
const codeButOwner = (dep: Deployment) => async (x: Address) => x.toLowerCase() !== dep.owner.toLowerCase();

describe("format detection", () => {
  test("the live v1 file is v1 (it has beta: true, but neither new field)", () => {
    expect(v1.beta).toBe(true);
    expect(deploymentVersion(v1)).toBe(1);
  });
  test("a MainnetBeta v2 output is v2", () => {
    expect(deploymentVersion(v2File())).toBe(2);
    expect(deploymentVersion({ ...v1, allowEoaOwner: true })).toBe(2);
  });
  test("forge's raw output (nested objects as JSON strings) is normalized", () => {
    const raw = { ...v1, stocks: JSON.stringify(v1.stocks), perpMarkets: JSON.stringify(v1.perpMarkets) };
    const n = normalize(raw);
    expect(n.stocks).toEqual(v1.stocks);
    expect(n.perpMarkets).toEqual(v1.perpMarkets!);
  });
  test("the v2 expectations are MainnetBeta.s.sol's constants", () => {
    const sol = readFileSync(join(import.meta.dir, "..", "..", "contracts", "script", "MainnetBeta.s.sol"), "utf8");
    const c = (name: string) => {
      const m = sol.match(new RegExp(`constant ${name} = ([^;]+);`));
      if (!m) throw new Error(`no ${name}`);
      const v = m[1]!.replace(/_/g, "").trim();
      const e = v.match(/^(\d+)e(\d+)$/);
      if (e) return BigInt(e[1]!) * 10n ** BigInt(e[2]!);
      const t = v.match(/^(\d+) (hours|minutes|days)(?: \+ (\d+) minutes)?$/);
      if (t) return BigInt(t[1]!) * { hours: 3600n, minutes: 60n, days: DAY }[t[2] as "hours"] + BigInt(t[3] ?? 0) * 60n;
      return BigInt(v.split(" ")[0]!);
    };
    expect(MAINNET_BETA_V2.perpOiCapBps).toBe(c("PERP_OI_CAP_BPS"));
    expect(MAINNET_BETA_V2.maxOpLossBps).toBe(c("GUARD_MAX_OP_LOSS_BPS"));
    expect(V2.perpOpenSpreadBps).toBe(c("PERP_OPEN_SPREAD_BPS"));
    expect(V2.perpTakerFeeBps).toBe(c("PERP_TAKER_FEE_BPS"));
    expect(V2.perpMakerFeeBps).toBe(c("PERP_MAKER_FEE_BPS"));
    expect(V2.perpMinHold).toBe(c("PERP_MIN_HOLD"));
    expect(V2.perpMinLiqReward).toBe(c("PERP_MIN_LIQ_REWARD"));
    expect(V2.perpMinCollateral).toBe(c("PERP_MIN_COLLATERAL"));
    expect(V2.calendarValidUntil).toBe(c("CALENDAR_VALID_UNTIL"));
    expect(V2.maxStalenessMainnet).toBe(c("DEFAULT_MAX_STALENESS"));
    expect(BigInt(V2.minCrowdMainnet)).toBe(c("DEFAULT_MIN_CROWD"));
    expect(V2.crowdDayOffset).toBe(c("CROWD_DAY_OFFSET"));
    expect(MAINNET_BETA_V2.timelock).toBe(c("TIMELOCK"));
    expect(MAINNET_BETA_V2.perpCooldown).toBe(c("PERP_COOLDOWN"));
    expect(MAINNET_BETA_V2.hiddenMinDepositUsdg).toBe(c("HIDDEN_MIN_DEPOSIT"));
    expect(MAINNET_BETA_V2.crowdSlippageBps).toBe(c("CROWD_SLIPPAGE_BPS"));
    // the holiday table and the stock list, day for day and address for address
    const days = (fn: string) => [...sol.slice(sol.indexOf(`function ${fn}()`)).split("];")[0]!.matchAll(/(?:uint256\()?(\d{5})\)?,? \/\//g)].map((m) => Number(m[1]));
    expect(days("nyseClosedDays")).toEqual(V2.closedDays);
    expect(days("nyseEarlyCloses")).toEqual(V2.earlyCloses);
    const stocks = [...sol.matchAll(/s\[\d+\] = Stock\("(\w+)", (0x[0-9a-fA-F]{40}), (0x[0-9a-fA-F]{40})/g)].map((m) => [m[1], m[2], m[3]]);
    expect(stocks).toEqual(V2.stocks);
  });
});

describe("hand-overs (review v2 L-20)", () => {
  const O = v1.owner;
  const D = v1.deployer;
  const C = getAddress("0x00000000000000000000000000000000000000c0");
  test("OWNER with nothing pending is ok", () => expect(handover("x", C, O, zeroAddress, O, D, true).status).toBe("ok"));
  test("the deployer with OWNER pending is a WARN, and a FAIL in strict mode", () => {
    expect(handover("x", C, D, O, O, D, false).status).toBe("WARN");
    expect(handover("x", C, D, O, O, D, true).status).toBe("FAIL");
  });
  test("anything else is a FAIL in both modes", () => {
    for (const strict of [false, true]) {
      expect(handover("x", C, D, zeroAddress, O, D, strict).status).toBe("FAIL"); // never handed over
      expect(handover("x", C, O, C, O, D, strict).status).toBe("FAIL"); // OWNER moving it elsewhere
      expect(handover("x", C, C, zeroAddress, O, D, strict).status).toBe("FAIL"); // a stranger
    }
  });
});

describe("holiday table ops alert (review v2 M-1)", () => {
  const until = V2.calendarValidUntil;
  test("FAIL under 90 days, WARN under 180, ok beyond", () => {
    expect(calendarCheck(until, until - 89n * DAY).status).toBe("FAIL");
    expect(calendarCheck(until, until - 90n * DAY + 1n).status).toBe("FAIL");
    expect(calendarCheck(until, until - 90n * DAY).status).toBe("WARN");
    expect(calendarCheck(until, until - 179n * DAY).status).toBe("WARN");
    expect(calendarCheck(until, until - 180n * DAY).status).toBe("ok");
    expect(calendarCheck(until, NOW).status).toBe("ok");
  });
  test("an expired table is a FAIL that says every price is on hold", () => {
    const c = calendarCheck(until, until + DAY);
    expect(c.status).toBe("FAIL");
    expect(c.detail).toContain("on hold");
  });
  test("the deployment check reads the Valuer's value and alerts on it", async () => {
    const dep = v2File();
    const soon = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: V2.calendarValidUntil - 60n * DAY });
    expect(fails(soon, /holiday table/)).toHaveLength(1);
    const later = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: V2.calendarValidUntil - 150n * DAY });
    expect(warns(later, /holiday table/)).toHaveLength(1);
    expect(fails(later, /./)).toHaveLength(0);
  });
  test("the Valuer's calendarValidUntil must be at least the file's (an extension passes, review v3 R3-ORC-3)", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep, { calendarValidUntil: V2.calendarValidUntil - DAY }), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /calendarValidUntil\(\) >= file/)).toHaveLength(1);
    const bad = v2File({ calendarValidUntil: Number(V2.calendarValidUntil) + 1 });
    const c2 = await verifyDeployment(bad, world(bad), codeAll, bad.chainId, { now: NOW });
    expect(fails(c2, /file calendarValidUntil == CALENDAR_VALID_UNTIL/)).toHaveLength(1);
  });
  test("a missing holiday is named", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep, { closedDay: false }), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /closedDay/)[0]?.detail).toContain("2026-11-26");
  });
});

describe("verifyDeployment v1 (the live file)", () => {
  test("a wrong chain id fails", async () => {
    const checks = await verifyDeployment(v1, stub(v1, v1.owner, zeroAddress), hasCode, 46630);
    expect(fails(checks, /^chain id$/)).toHaveLength(1);
  });

  test("a pending hand-over is a WARN on every two-step contract, a FAIL in strict mode", async () => {
    const loose = await verifyDeployment(v1, stub(v1, v1.deployer, v1.owner), hasCode, v1.chainId);
    expect(warns(loose, /hand-over/).length).toBe(11); // 7 contracts + 4 perp markets
    expect(fails(loose, /hand-over/)).toHaveLength(0);
    expect(fails(loose, /\.owner\(\) == OWNER$/).length).toBe(2); // one-step: the deployer is simply wrong
    const strict = await verifyDeployment(v1, stub(v1, v1.deployer, v1.owner), hasCode, v1.chainId, { strict: true });
    expect(fails(strict, /hand-over/).length).toBe(11);
  });

  test("an admin role with the deployer and nothing pending fails everywhere", async () => {
    const checks = await verifyDeployment(v1, stub(v1, v1.deployer, zeroAddress), hasCode, v1.chainId);
    expect(fails(checks, /hand-over|\.owner\(\) == OWNER$|committee/).length).toBeGreaterThanOrEqual(14);
  });

  test("correct owners pass those checks", async () => {
    const checks = await verifyDeployment(v1, stub(v1, v1.owner, zeroAddress), hasCode, v1.chainId, { strict: true });
    expect(fails(checks, /owner|hand-over|keeper\(\)|committee/i)).toHaveLength(0);
    expect(checks.filter((c) => c.status === "ok" && /hand-over|\.owner\(\) == OWNER$/.test(c.what)).length).toBe(13);
  });

  test("unreadable values and missing code are failures, not passes", async () => {
    const checks = await verifyDeployment(v1, stub(v1, v1.owner, zeroAddress), async () => false, v1.chainId);
    expect(fails(checks, /: code$/).length).toBeGreaterThanOrEqual(19);
    expect(fails(checks, /valuer\.maxStaleness|crowdBuy\.WINDOW|registry entry|stock checks/).length).toBeGreaterThan(0);
    expect(checks.some((c) => c.status === "ok" && /maxStaleness|WINDOW|GRACE|CAP_DELAY/.test(c.what))).toBe(false);
  });

  test("a healthy v1 chain passes with the v1 values and runs no v2 checks", async () => {
    const checks = await verifyDeployment(v1, world(v1), codeAll, v1.chainId, { strict: true, now: NOW });
    expect(fails(checks, /./)).toEqual([]);
    expect(checks.some((c) => /calendar|openSpreadBps|OWNER is a contract/.test(c.what))).toBe(false);
    expect(checks.find((c) => c.what === "perpMarket TSLA.oiCapBps()")?.detail).toBe("10000");
  });
});

describe("verifyDeployment v2", () => {
  test("a healthy v2 deploy is all ok in strict mode", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { strict: true, now: NOW });
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(checks.length).toBeGreaterThan(200);
  });

  test("v1 risk values on a v2 file fail (OI cap, guard loss bound, perp guards)", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep, { oiCapBps: 10_000n, maxOpLossBps: 200n, "perpMarket.makerFeeBps": 2n, minCollateral: 0n }), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /oiCapBps/)).toHaveLength(4);
    expect(fails(checks, /maxOpLossBps/)).toHaveLength(1);
    expect(fails(checks, /makerFeeBps/)).toHaveLength(4);
    expect(fails(checks, /minCollateral/)).toHaveLength(4);
  });

  test("the valuer is a two-step hand-over in v2, and the template committee too", async () => {
    const dep = v2File();
    const r = world(dep, { "valuer.owner": dep.deployer, "valuer.pendingOwner": dep.owner, "templateRegistry.pendingCommittee": dep.keeper });
    const loose = await verifyDeployment(dep, r, codeAll, dep.chainId, { now: NOW });
    expect(warns(loose, /^valuer hand-over/)).toHaveLength(1);
    expect(fails(loose, /templateRegistry hand-over/)).toHaveLength(1);
    const strict = await verifyDeployment(dep, r, codeAll, dep.chainId, { strict: true, now: NOW });
    expect(fails(strict, /^valuer hand-over/)).toHaveLength(1);
  });

  test("OWNER must be a contract unless allowEoaOwner (fork mode exempt)", async () => {
    const dep = v2File();
    const c1 = await verifyDeployment(dep, world(dep), codeButOwner(dep), dep.chainId, { now: NOW });
    expect(fails(c1, /OWNER is a contract/)).toHaveLength(1);
    const eoa = v2File({ allowEoaOwner: true });
    const c2 = await verifyDeployment(eoa, world(eoa), codeButOwner(eoa), eoa.chainId, { now: NOW });
    expect(warns(c2, /OWNER is a contract/)).toHaveLength(1);
    expect(fails(c2, /OWNER/)).toHaveLength(0);
    const fork = v2File({ fork: true, chainId: 31337 });
    const c3 = await verifyDeployment(fork, world(fork), codeButOwner(fork), 31337, { now: NOW });
    expect(fails(c3, /OWNER is a contract/)).toHaveLength(0);
  });

  test("review v3 R3-ORC-2: an EIP-7702 delegated EOA OWNER is not a contract", async () => {
    const dep = v2File();
    const delegated = async (x: Address): Promise<Hex | undefined> =>
      x.toLowerCase() === dep.owner.toLowerCase() ? "0xef01001111111111111111111111111111111111111111" : "0x6080";
    const c1 = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW, codeOf: delegated });
    expect(fails(c1, /OWNER is a contract/)).toHaveLength(1);
    expect(c1.find((c) => c.what === "OWNER is a contract")?.detail).toMatch(/7702/);
    const eoa = v2File({ allowEoaOwner: true });
    const c2 = await verifyDeployment(eoa, world(eoa), codeAll, eoa.chainId, { now: NOW, codeOf: delegated });
    expect(warns(c2, /OWNER is a contract/)).toHaveLength(1);
    const safe = async (): Promise<Hex | undefined> => "0x608060405234801561001057600080fd5b50";
    const c3 = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW, codeOf: safe });
    expect(fails(c3, /OWNER is a contract/)).toHaveLength(0);
    expect(isDelegatedEoaCode("0xEF0100aa")).toBe(true);
    expect(isDelegatedEoaCode("0x60")).toBe(false);
    expect(isDelegatedEoaCode(undefined)).toBe(false);
  });

  test("mainnet pins: staleness <= 26 h and MIN_CROWD >= 3 (not in fork mode)", async () => {
    const dep = v2File({ maxStaleness: 7 * 86_400, minCrowd: 1 });
    const checks = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /maxStaleness <= 26 h/)).toHaveLength(1);
    expect(fails(checks, /MIN_CROWD >= 3/)).toHaveLength(1);
    const fork = v2File({ fork: true, chainId: 31337, maxStaleness: 7 * 86_400, minCrowd: 1 });
    const c2 = await verifyDeployment(fork, world(fork), codeAll, 31337, { now: NOW });
    expect(fails(c2, /26 h|MIN_CROWD >= 3/)).toHaveLength(0);
  });

  test("a genesis off the 19:30 UTC grid and a missing stock fail", async () => {
    const stocks = { ...v2File().stocks };
    delete stocks.USO;
    const dep = v2File({ genesis: Number(NOW - (NOW % DAY)), stocks });
    const checks = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /19:30 UTC/)).toHaveLength(1);
    expect(fails(checks, /file stocks == MainnetBeta/)).toHaveLength(1);
  });
});

describe("exit code", () => {
  test("FAIL exits 1; WARN only with --fail-on-warn", () => {
    const c = (status: "ok" | "WARN" | "FAIL") => ({ status, what: "", detail: "" });
    expect(exitCode(summarize([c("ok"), c("WARN")]), false)).toBe(0);
    expect(exitCode(summarize([c("ok"), c("WARN")]), true)).toBe(1);
    expect(exitCode(summarize([c("FAIL")]), false)).toBe(1);
    expect(summarize([c("ok"), c("WARN"), c("FAIL")])).toEqual({ ok: 1, warn: 1, fail: 1, total: 3 });
  });

  test("review v4 R4-ORC-1: OWNER must be a Safe with threshold >= 2 (a 1-of-1 or a non-Safe contract fails)", async () => {
    const dep = v2File();
    const ok = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW });
    expect(ok.find((c) => c.what === "OWNER is a contract")).toMatchObject({ status: "ok", detail: expect.stringMatching(/2-of-3/) });
    const one = await verifyDeployment(dep, world(dep, { getThreshold: 1n, getOwners: [A1] }), codeAll, dep.chainId, { now: NOW });
    expect(fails(one, /OWNER is a contract/)).toHaveLength(1);
    const bad = await verifyDeployment(dep, world(dep, { getThreshold: 3n, getOwners: [A1, A2] }), codeAll, dep.chainId, { now: NOW });
    expect(fails(bad, /OWNER is a contract/)).toHaveLength(1);
    const base = world(dep);
    const notSafe: Reader = async (address, sig, args) => {
      if (/getThreshold|getOwners/.test(sig)) throw new Error("execution reverted");
      return base(address, sig, args);
    };
    const ns = await verifyDeployment(dep, notSafe, codeAll, dep.chainId, { now: NOW });
    expect(fails(ns, /OWNER is a contract/)).toHaveLength(1);
    const eoaOk = v2File({ allowEoaOwner: true });
    const w = await verifyDeployment(eoaOk, world(eoaOk, { getThreshold: 1n, getOwners: [A1] }), codeAll, eoaOk.chainId, { now: NOW });
    expect(warns(w, /OWNER is a contract/)).toHaveLength(1);
  });

  test("review v3 R3-ORC-3: an extended holiday table passes; a shortened one fails", async () => {
    const dep = v2File();
    const longer = await verifyDeployment(dep, world(dep, { calendarValidUntil: V2.calendarValidUntil + 365n * DAY }), codeAll, dep.chainId, { strict: true, now: NOW });
    expect(fails(longer, /calendarValidUntil/)).toHaveLength(0);
    const shorter = await verifyDeployment(dep, world(dep, { calendarValidUntil: V2.calendarValidUntil - DAY }), codeAll, dep.chainId, { now: NOW });
    expect(fails(shorter, /calendarValidUntil\(\) >= file/)).toHaveLength(1);
  });

  test("review v2 I-5: the remaining perp risk params are pinned", async () => {
    const dep = v2File();
    const c = await verifyDeployment(dep, world(dep, { "perpMarket.borrowBpsPerHour": 100n, "perpMarket.liquidationFee": 1_000_000n }), codeAll, dep.chainId, { now: NOW });
    expect(fails(c, /borrowBpsPerHour/).length).toBeGreaterThan(0);
    expect(fails(c, /liquidationFee/).length).toBeGreaterThan(0);
  });

describe("adapter allow-list (v2)", () => {
  test("a shipped sleeve missing from the treasury factory's allow-list is a FAIL", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep, { "treasuryFactory.isAdapterAllowed": false }), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /isAdapterAllowed\(cashSleeve\)/).length).toBe(1);
    expect(fails(checks, /isAdapterAllowed\(equitySleeve\)/).length).toBe(1);
  });
  test("the treasury factory's ownership is checked like every two-step role", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep, { "treasuryFactory.owner": dep.deployer }), codeAll, dep.chainId, { now: NOW, strict: true });
    expect(fails(checks, /treasuryFactory hand-over/).length).toBe(1);
  });
});

describe("adapter allow-list enumeration (v2)", () => {
  test("an extra allowed codehash (e.g. added by the deployer during setup) is a FAIL that names it", async () => {
    const dep = v2File();
    const extra = keccak256("0x1234");
    const reader = world(dep, { "treasuryFactory.allowedHashes": [keccak256(getAddress(dep.cashSleeve as string).toLowerCase() as Hex), keccak256(getAddress(dep.equitySleeve as string).toLowerCase() as Hex), extra] });
    const checks = await verifyDeployment(dep, reader, codeAll, dep.chainId, { now: NOW });
    const f = fails(checks, /allow-list == shipped sleeves/);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain(extra);
  });
  test("the shipped set passes", async () => {
    const dep = v2File();
    const checks = await verifyDeployment(dep, world(dep), codeAll, dep.chainId, { now: NOW });
    expect(fails(checks, /allow-list/)).toHaveLength(0);
  });
});
});
