import { contracts } from "@/chain";
import type { Db } from "@/db";
import type { Deployment } from "@/indexer";
import { getAddress, isAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { MockFeedOptions } from "./jobs/mock-feeds";
import type { Sealer } from "./seal";
import type { PlaidLike } from "./sources/plaid";
import { revertOf, type Sender, type SimResult } from "./sender";

export type KeeperDeployment = {
  vault: Address;
  crowd: Address;
  beacon: Address;
  usdg: Address;
  permit2: Address;
  multicall3: Address;
  /** Stock Tokens the keeper runs books for. */
  stocks: Address[];
  /** Every Plynth contract (lowercase): a spend into one of these is not a round-up. */
  plynth: Set<string>;
  /** Quiet delivery; absent until StealthClaims is deployed and wired. */
  stealthClaims?: Address | undefined;
  erc6538Registry: Address;
  /** Hidden delivery; absent until ShieldedPool is deployed and wired. */
  shieldedPool?: Address | undefined;
  /** Mock feeds of a testnet kit deployment (job refresh-mock-feeds). */
  mock: MockFeedDeployment;
  /** FeeRouter (job fee-push); absent when the token stack is not deployed. */
  feeRouter?: Address | undefined;
  /** In-house perp markets (job liquidate): `perpMarkets` in the file (symbol -> address, or that map as JSON). */
  perpMarkets: Address[];
};

/** `perpMarkets` of a deployment file: a symbol -> address map (the deploy scripts write it as an object or as a JSON string). */
export function perpMarketsOf(dep: Deployment): Address[] {
  let raw: unknown = dep.perpMarkets;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== "object") return [];
  return Object.values(raw as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string" && isAddress(v))
    .map((v) => getAddress(v));
}

/** One mock Stock Token of a testnet kit: its feed and v4 pool (as TestnetKit.s.sol writes them). */
export type MockStock = {
  symbol: string;
  /** Mainnet Stock Token whose real feed this one tracks: `underlying` in the file, else the symbol without its leading "m". */
  underlying: string;
  token: Address;
  feed: Address;
  poolId?: Hex | undefined;
  fee?: number | undefined;
  currency0?: Address | undefined;
  currency1?: Address | undefined;
};

export type MockFeedDeployment = {
  /** `mockFeeds` in the file: true = testnet kit feeds, false = never touch, undefined = file predates the flag. */
  flag: boolean | undefined;
  stocks: MockStock[];
  usdg?: Address | undefined;
  registry?: Address | undefined;
  valuer?: Address | undefined;
  router?: Address | undefined;
  poolManager?: Address | undefined;
};

/** The refresh-mock-feeds slice of a deployment file. Never throws on a missing field: old files stay readable. */
export function mockFeedDeployment(dep: Deployment): MockFeedDeployment {
  const addr = (v: unknown): Address | undefined => (typeof v === "string" && isAddress(v) ? getAddress(v) : undefined);
  const stocks: MockStock[] = [];
  for (const [symbol, raw] of Object.entries((dep.stocks ?? {}) as Record<string, Record<string, unknown>>)) {
    const token = addr(raw.token);
    const feed = addr(raw.feed);
    if (!token || !feed) continue;
    stocks.push({
      symbol,
      underlying: typeof raw.underlying === "string" ? raw.underlying : symbol.replace(/^m(?=[A-Z])/, ""),
      token,
      feed,
      poolId: typeof raw.poolId === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw.poolId) ? (raw.poolId as Hex) : undefined,
      fee: raw.fee === undefined ? undefined : Number(raw.fee),
      currency0: addr(raw.currency0),
      currency1: addr(raw.currency1),
    });
  }
  return {
    flag: typeof dep.mockFeeds === "boolean" ? dep.mockFeeds : undefined,
    stocks,
    usdg: addr(dep.usdg),
    registry: addr(dep.stockTokenRegistry),
    valuer: addr(dep.valuer),
    router: addr(dep.stockRouter),
    poolManager: addr(dep.poolManager),
  };
}

const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CANONICAL_ERC6538 = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

/** Reads the addresses the keeper needs from deployments/<chainid>.json (written by the deploy scripts). */
export function keeperDeployment(dep: Deployment | undefined, chainId: number): KeeperDeployment {
  if (!dep) throw new Error(`no deployments/${chainId}.json`);
  const need = (k: string): Address => {
    const v = dep[k];
    if (typeof v !== "string") throw new Error(`deployment ${chainId} has no ${k}`);
    return getAddress(v);
  };
  const net = chainId === 4663 ? contracts.mainnet : chainId === 46630 ? contracts.testnet : undefined;
  const opt = (k: string, fallback: string): Address => getAddress(typeof dep[k] === "string" ? (dep[k] as string) : fallback);
  const stocks = Object.values(dep.stocks ?? {}).map((s) => getAddress(s.token));
  const plynth = new Set<string>();
  for (const [k, v] of Object.entries(dep)) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && k !== "deployer") plynth.add(v.toLowerCase());
  }
  return {
    vault: need("savingsVault"),
    crowd: need("crowdBuy"),
    beacon: need("jitterBeacon"),
    usdg: need("usdg"),
    permit2: opt("permit2", CANONICAL_PERMIT2),
    multicall3: opt("multicall3", (net as { multicall3?: string } | undefined)?.multicall3 ?? CANONICAL_MULTICALL3),
    stocks,
    plynth,
    stealthClaims: typeof dep.stealthClaims === "string" ? getAddress(dep.stealthClaims) : undefined,
    erc6538Registry: opt("erc6538Registry", CANONICAL_ERC6538),
    shieldedPool: typeof dep.shieldedPool === "string" ? getAddress(dep.shieldedPool) : undefined,
    mock: mockFeedDeployment(dep),
    feeRouter: typeof dep.feeRouter === "string" ? getAddress(dep.feeRouter) : undefined,
    perpMarkets: perpMarketsOf(dep),
  };
}

export type Ctx = {
  chainId: number;
  db: Db;
  pub: PublicClient;
  account: Address;
  sender: Sender;
  sealer: Sealer;
  dep: KeeperDeployment;
  /** Windows ahead to commit beacons for (>= 2 keeps execution alive through one fully missed window). */
  lookahead: number;
  /** Quiet delivery: parts per allocation, 1-3 (default 2), released across consecutive executions. */
  splitParts?: number;
  /**
   * Quiet delivery proofs (receipts, Delivered / Claimed / Credited logs, the nonce) are read at head minus this many
   * blocks, so a transaction a reorg can still remove is never proof (KEEPER_CONFIRMATIONS; absent = 0).
   */
  confirmations?: number;
  /** Plaid client (PLAID_CLIENT_ID/PLAID_SECRET/PLAID_ENV); absent = Plaid sources are not synced. */
  plaid?: PlaidLike | undefined;
  /**
   * Statement / Plaid / on-chain accrual limits (KEEPER_MAX_ACCRUALS_PER_PASS / _PER_USER_WEEK, audit M-7;
   * KEEPER_MAX_ACCRUALS_PER_USER_PASS, KEEPER_MIN_ACCRUE_CENTS, KEEPER_ACCRUE_PASS_MS / _GAS, review v2 V2-M5;
   * KEEPER_MIN_ONCHAIN_ACCRUE_CENTS, review v3 R3-SVC-2).
   */
  accrueLimits?: { perPass: number; perUserWeek: number; perUserPass?: number; minAccrueCents?: number; minOnchainAccrueCents?: number; carryMaxAgeDays?: number; passMs?: number; passGas?: bigint } | undefined;
  /** perp-poke: a market's stored price older than this many seconds is refreshed (KEEPER_PERP_POKE_AGE_S, default 3600). */
  perpPokeAgeS?: number;
  /** refresh-mock-feeds settings and its mainnet feed reader; absent = the job does nothing. */
  mockFeeds?: MockFeedOptions | undefined;
  log: (m: string) => void;
};

/** KEEPER_CONFIRMATIONS when set, else 2 on testnet/mainnet and 0 on a local anvil (which never reorgs by itself). */
export function keeperConfirmations(chain: "local" | "testnet" | "mainnet", configured: number | undefined): number {
  return configured ?? (chain === "local" ? 0 : 2);
}

/**
 * The newest block a proof may rest on: head - confirmations (never below 0). The head is read uncached (viem
 * caches it for its polling interval).
 */
export async function confirmedBlock(ctx: Pick<Ctx, "pub" | "confirmations">): Promise<{ head: bigint; at: bigint }> {
  const head = await ctx.pub.getBlockNumber({ cacheTime: 0 });
  const c = BigInt(ctx.confirmations ?? 0);
  return { head, at: head > c ? head - c : 0n };
}

/** Chain time, not wall time: the latest block's timestamp (anvil tests warp it). */
export async function chainNow(ctx: Pick<Ctx, "pub">): Promise<bigint> {
  const b = await ctx.pub.getBlock({ blockTag: "latest" });
  return b.timestamp;
}

/** eth_call as the keeper. A revert comes back as { ok: false, errorName } instead of a throw. */
export async function simulate(ctx: Pick<Ctx, "pub" | "account">, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<SimResult> {
  try {
    const r = await ctx.pub.simulateContract({ account: ctx.account, address, abi, functionName, args } as any);
    return { ok: true, result: r.result };
  } catch (err) {
    const rev = revertOf(err);
    if (!rev) throw err; // transport trouble: let the job fail and retry next pass
    return { ok: false, errorName: rev.errorName, args: rev.args, message: (err as Error).message.split("\n")[0]! };
  }
}

export type JobResult = { job: string; ok: boolean; actions: number; notes: string[]; error?: string };
