// Basis desk (T2, rule-only): runs delta-neutral carry pairs on a BasisSleeve (spot the account holds + a perp
// short of the same underlying).
//   open  when funding has paid shorts (longs pay, rate > 0) for >= `fundingHours` hours in a row, spot depth for
//         the size is fine (V4Quoter: selling the lot back loses <= maxSlippageBps vs the oracle), the caps leave
//         room, the drawdown state is normal and markets are open;
//   close on a funding flip (rate <= 0), a cap breach, or any drawdown state other than normal.
// Carry is reported as NAV per CLOSED period only: an absolute USD amount for the pairs closed inside the
// period, never as a rate or an annualised yield.
import { encodeAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import type { DrawdownState } from "../risk/drawdown";
import { basisSleeveAbi } from "../venues/abi";
import { AccountExecutor, runData } from "../venues/inhouse";
import type { Rejection } from "./errors";

export type BasisConfig = {
  fundingHours?: number; // default 8
  maxSlippageBps?: number; // default 50
  pairSizeUsd: bigint; // cash units (USDG 6 dp) of perp notional per pair
  collateralBps?: number; // margin per notional (default 5000 = 2x)
};

/** Tracks for how long each (venue, underlying) funding has been positive without a break. */
export class FundingStreaks {
  private since = new Map<string, number>();

  /** `ts` in unix seconds; `rate` signed 1e18/s (> 0 longs pay). Returns the streak length in seconds. */
  observe(key: string, ts: number, rate: bigint): number {
    if (rate <= 0n) {
      this.since.delete(key);
      return 0;
    }
    if (!this.since.has(key)) this.since.set(key, ts);
    return ts - this.since.get(key)!;
  }

  streak(key: string, ts: number): number {
    const s = this.since.get(key);
    return s === undefined ? 0 : ts - s;
  }
}

export type BasisInput = {
  fundingRate: bigint; // now, signed 1e18/s
  streakSec: number;
  openPairId: bigint | null;
  drawdown: DrawdownState;
  offHours: boolean;
  depthOk: boolean;
  floatRoom: boolean; // pairing the size stays inside perNameFloatCapBps
  venueRoom: boolean; // the venue's pair notional stays inside perVenueCapBps
  capBreached: boolean; // an open pair is now over a cap (supply shrank, NAV fell)
};

export type BasisDecision = { action: "open" | "close" | "hold"; reason: string };

export function decideBasis(i: BasisInput, cfg: Pick<BasisConfig, "fundingHours">): BasisDecision {
  const need = (cfg.fundingHours ?? 8) * 3600;
  if (i.openPairId !== null) {
    if (i.fundingRate <= 0n) return { action: "close", reason: "funding_flip" };
    if (i.capBreached) return { action: "close", reason: "cap_breach" };
    if (i.drawdown !== "normal") return { action: "close", reason: `drawdown_${i.drawdown}` };
    return { action: "hold", reason: "carrying" };
  }
  if (i.drawdown !== "normal") return { action: "hold", reason: `drawdown_${i.drawdown}` };
  if (i.offHours) return { action: "hold", reason: "off_hours" };
  if (i.fundingRate <= 0n) return { action: "hold", reason: "funding_not_positive" };
  if (i.streakSec < need) return { action: "hold", reason: "funding_streak_short" };
  if (!i.depthOk) return { action: "hold", reason: "spot_depth" };
  if (!i.floatRoom) return { action: "hold", reason: "float_cap" };
  if (!i.venueRoom) return { action: "hold", reason: "venue_cap" };
  return { action: "open", reason: "funding_positive" };
}

/** Spot depth from a V4Quoter quote: selling the lot returns >= oracle value x (1 - maxSlippageBps). */
export function depthOk(quotedOutUsd: bigint, oracleUsd: bigint, maxSlippageBps: number): boolean {
  return quotedOutUsd * 10_000n >= oracleUsd * BigInt(10_000 - maxSlippageBps);
}

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const routerPoolAbi = [
  {
    type: "function",
    name: "poolOf",
    stateMutability: "view",
    inputs: [{ name: "stockToken", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
  },
] as const;

/** USDG out (raw) for selling `tokens` of `stock` in the StockRouter's pool, via the Uniswap v4 Quoter (eth_call). */
export async function quoteSpotSell(pub: PublicClient, quoter: Address, router: Address, stock: Address, tokens: bigint): Promise<bigint> {
  const key = await pub.readContract({ address: router, abi: routerPoolAbi, functionName: "poolOf", args: [stock] });
  const zeroForOne = key.currency0.toLowerCase() === stock.toLowerCase();
  const { result } = await pub.simulateContract({ address: quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: tokens, hookData: "0x" }] });
  return result[0];
}

// ---------------------------------------------------------------- on-chain execution (BasisSleeve)

export type PairRow = {
  id: bigint;
  underlying: Address;
  spotRaw: bigint;
  perpTokens: bigint;
  entryPriceUsd: bigint;
  collateral: bigint;
  openedAt: bigint;
  closedAt: bigint;
  cumulativeFundingUsd: bigint;
};

export class BasisSleeveDesk {
  constructor(
    readonly pub: PublicClient,
    readonly exec: AccountExecutor,
    readonly sleeve: Address,
    readonly usdg: Address,
    readonly venueProof: Hex[] = [],
    /** USDG's instrument allow proof: a close sends the freed margin back to the account (rule 2). */
    readonly cashProof: Hex[] = [],
  ) {}

  async openPairId(venueIdx: number, u: Address): Promise<bigint | null> {
    const v = await this.pub.readContract({ address: this.sleeve, abi: basisSleeveAbi, functionName: "openPairOf", args: [BigInt(venueIdx), u] });
    return v === 0n ? null : v - 1n;
  }

  async open(venueIdx: number, u: Address, sizeUsd: bigint, collateral: bigint, maxSlippageBps: number): Promise<{ ok: true; tx: Hex } | { ok: false; rejection: Rejection }> {
    const args = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [u, sizeUsd, collateral, BigInt(maxSlippageBps)]);
    return this.exec.execute(this.sleeve, AccountExecutor.data([{ token: this.usdg, amount: collateral }], runData(0, venueIdx, args)), [this.venueProof]);
  }

  async close(pairId: bigint) {
    return this.exec.execute(this.sleeve, AccountExecutor.data([], runData(1, Number(pairId), "0x")), [this.cashProof]);
  }

  async pairs(): Promise<PairRow[]> {
    const n = await this.pub.readContract({ address: this.sleeve, abi: basisSleeveAbi, functionName: "pairCount" });
    const out: PairRow[] = [];
    for (let i = 0n; i < n; i++) {
      const p = await this.pub.readContract({ address: this.sleeve, abi: basisSleeveAbi, functionName: "pair", args: [i] });
      out.push({ id: i, underlying: p.underlying, spotRaw: p.spotRaw, perpTokens: p.perpTokens, entryPriceUsd: p.entryPriceUsd, collateral: p.collateral, openedAt: p.openedAt, closedAt: p.closedAt, cumulativeFundingUsd: p.cumulativeFundingUsd });
    }
    return out;
  }
}

// ---------------------------------------------------------------- reporting: NAV per closed period, never a rate

export type BasisPeriodReport = {
  periodStart: bigint; // unix s, inclusive
  periodEnd: bigint; // unix s, exclusive
  pairsClosed: number;
  /** Realized carry (funding net of borrow and fees) of pairs closed in the period, USD 1e18. */
  navContributionUsd: bigint;
};

/** Pairs still open contribute nothing: their carry is not realized and is never extrapolated. */
export function basisPeriodReport(pairs: PairRow[], periodStart: bigint, periodEnd: bigint): BasisPeriodReport {
  const closed = pairs.filter((p) => p.closedAt !== 0n && p.closedAt >= periodStart && p.closedAt < periodEnd);
  return { periodStart, periodEnd, pairsClosed: closed.length, navContributionUsd: closed.reduce((s, p) => s + p.cumulativeFundingUsd, 0n) };
}
