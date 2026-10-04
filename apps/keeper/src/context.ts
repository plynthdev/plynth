import { contracts } from "@plynth/chain";
import type { Db } from "@plynth/db";
import type { Deployment } from "@plynth/indexer";
import { getAddress, type Abi, type Address, type PublicClient } from "viem";
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
  stealthClaims?: Address;
  erc6538Registry: Address;
};

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
  /** Plaid client (PLAID_CLIENT_ID/PLAID_SECRET/PLAID_ENV); absent = Plaid sources are not synced. */
  plaid?: PlaidLike;
  log: (m: string) => void;
};

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
