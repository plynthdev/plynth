// One perp venue as the off-chain desks and the reconciler see it. Units match the on-chain IPerpVenue:
// positions in Stock Token base units (signed, + long), equity in USD 1e18, funding as a signed 1e18 fraction
// of size per second (> 0: longs pay shorts).
//
// There is deliberately no withdraw method on any client. Off-chain venue keys are trade-only; collateral
// leaves a venue only through the on-chain PerpSleeve, and only to the treasury account.
import type { Address } from "viem";

export type VenueKind = "inhouse" | "orderly" | "arcus";

/** A venue market for one Stock Token. `multiplier` is the token's uiMultiplier (1e18): 1 token = multiplier
 *  shares, and off-chain venues quote perps in shares. */
export type MarketMap = { underlying: Address; symbol: string; multiplier: bigint };

export type VenuePosition = { underlying: Address; tokens: bigint };

export type FundingQuote = { underlying: Address; ratePerSecond: bigint };

export type VenueStatement = {
  venue: string; // client name (or the on-chain adapter address)
  ts: number; // unix ms the venue reported
  positions: VenuePosition[];
  equityUsd: bigint;
  /** Venue positions in markets the treasury does not map (always a reconcile break). */
  unmapped?: string[];
};

export type OrderRequest = {
  underlying: Address;
  side: "buy" | "sell";
  tokens: bigint; // > 0, Stock Token base units
  reduceOnly: boolean;
  /** Protective bound against the venue mark (market orders), in bps. */
  maxSlippageBps: number;
};

export type OrderResult = { id: string; status: string; tokens: bigint; side: "buy" | "sell"; underlying: Address };

export interface PerpVenueClient {
  readonly kind: VenueKind;
  readonly name: string;
  funding(): Promise<FundingQuote[]>;
  statement(): Promise<VenueStatement>;
  placeOrder(o: OrderRequest): Promise<OrderResult>;
}

export class VenueError extends Error {
  constructor(
    readonly venue: string,
    readonly status: number | null,
    message: string,
    readonly body?: unknown,
  ) {
    super(`${venue}: ${message}`);
  }
}
