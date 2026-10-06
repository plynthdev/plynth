// The in-house perp engine (todo 20) as a PerpVenueClient: reads straight from the InHousePerpVenue adapter and
// its markets; orders go through TreasuryAccount.execute on the PerpSleeve (hedge) with the desk key, after an
// eth_call simulation. The default venue for tests and testnet.
import { encodeAbiParameters, getAddress, type Address, type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type WalletClient } from "viem";
import { accountAbi } from "@/abi/treasury-desks";
import { withGasHeadroom } from "@/lib/gas";
import { decodeRejection, type Rejection } from "@/treasury/desks/errors";
import { deskIdBytes, packProofs } from "@/treasury/desks/runner";
import { basisSleeveAbi, inHouseVenueAbi, marketAbi, venueValuerAbi } from "@/abi/treasury-venues";
import type { FundingQuote, OrderRequest, OrderResult, PerpVenueClient, VenueStatement } from "./types";
import { VenueError } from "./types";

const PULLS = { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] } as const;
const E18 = 10n ** 18n;
/** The account's ABI plus the sleeve errors a simulation can surface by name. */
const execAbi = [...accountAbi, ...basisSleeveAbi.filter((i) => i.type === "error")] as const;

/** Simulates then sends TreasuryAccount.execute from one desk key. */
export class AccountExecutor {
  constructor(
    readonly pub: PublicClient,
    readonly wallet: WalletClient,
    readonly key: PrivateKeyAccount,
    readonly chain: Chain,
    readonly account: Address,
    readonly deskId: string,
  ) {}

  static data(pulls: { token: Address; amount: bigint }[], runData: Hex): Hex {
    return encodeAbiParameters([PULLS, { type: "bytes" }], [pulls, runData]);
  }

  /** `proofs`: one Merkle proof per increased asset then per venue whose risk went up (PolicyGuard order). */
  async execute(adapter: Address, data: Hex, proofs: Hex[][] = []): Promise<{ ok: true; tx: Hex } | { ok: false; rejection: Rejection }> {
    const args = [deskIdBytes(this.deskId), adapter, data, packProofs(proofs), `0x${"0".repeat(64)}` as Hex] as const;
    try {
      await this.pub.simulateContract({ address: this.account, abi: execAbi, functionName: "execute", args, account: this.key, chain: this.chain });
    } catch (e) {
      return { ok: false, rejection: decodeRejection(e) };
    }
    // Explicit gas: a bare estimate can miss accrual the venue does once a second has passed (lib/gas.ts).
    const gas = withGasHeadroom(await this.pub.estimateContractGas({ address: this.account, abi: accountAbi, functionName: "execute", args, account: this.key }));
    const tx = await this.wallet.writeContract({ address: this.account, abi: accountAbi, functionName: "execute", args, account: this.key, chain: this.chain, gas });
    const r = await this.pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") return { ok: false, rejection: { code: null, reason: "reverted on-chain" } };
    return { ok: true, tx };
  }
}

export type InHouseConfig = {
  venue: Address; // InHousePerpVenue adapter
  valuer: Address;
  usdg: Address;
  /** For orders (hedge desk): the PerpSleeve that owns `venue`, its index there, and the venue allow proof. */
  sleeve?: Address;
  venueIdx?: number;
  venueProof?: Hex[];
  executor?: AccountExecutor;
  /** Margin posted per unit of new notional, bps (default 5000 = 2x). */
  marginBps?: number;
  usdgDecimals?: number;
};

export class InHouseClient implements PerpVenueClient {
  readonly kind = "inhouse" as const;
  readonly name: string;

  constructor(
    readonly pub: PublicClient,
    readonly cfg: InHouseConfig,
  ) {
    this.name = getAddress(cfg.venue);
  }

  async funding(): Promise<FundingQuote[]> {
    const markets = await this.pub.readContract({ address: this.cfg.venue, abi: inHouseVenueAbi, functionName: "markets" });
    const out: FundingQuote[] = [];
    for (const m of markets) {
      const [u, [rate, longsPay]] = await Promise.all([
        this.pub.readContract({ address: m, abi: marketAbi, functionName: "underlying" }),
        this.pub.readContract({ address: m, abi: marketAbi, functionName: "fundingRate" }),
      ]);
      out.push({ underlying: u, ratePerSecond: longsPay ? rate : -rate });
    }
    return out;
  }

  async statement(): Promise<VenueStatement> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const [pos, [equity]] = await Promise.all([
      this.pub.readContract({ address: this.cfg.venue, abi: inHouseVenueAbi, functionName: "positionOf", blockNumber: block.number }),
      this.pub.readContract({ address: this.cfg.venue, abi: inHouseVenueAbi, functionName: "equityOf", blockNumber: block.number }),
    ]);
    return { venue: this.name, ts: Number(block.timestamp) * 1000, positions: pos.map((p) => ({ underlying: p.underlying, tokens: p.tokens })), equityUsd: equity };
  }

  private toCash(usd18: bigint) {
    return usd18 / 10n ** BigInt(18 - (this.cfg.usdgDecimals ?? 6));
  }

  /** sell (not reduce-only) = open/increase a short with fresh margin; buy reduce-only = close part of the short. */
  async placeOrder(o: OrderRequest): Promise<OrderResult> {
    const { executor, sleeve, venueIdx = 0, venueProof = [] } = this.cfg;
    if (!executor || !sleeve) throw new VenueError(this.name, null, "read-only in-house client");
    if (o.tokens <= 0n) throw new VenueError(this.name, null, "order size must be > 0");
    const market = await this.pub.readContract({ address: this.cfg.venue, abi: inHouseVenueAbi, functionName: "marketOf", args: [o.underlying] });
    const pos = await this.pub.readContract({ address: market, abi: marketAbi, functionName: "position", args: [this.cfg.venue] });
    const q = await this.pub.readContract({ address: this.cfg.valuer, abi: venueValuerAbi, functionName: "quote", args: [o.underlying] });

    if (o.side === "sell" && !o.reduceOnly) {
      if (pos.size !== 0n && pos.isLong) throw new VenueError(this.name, null, "the venue holds a long: reduce it first");
      const sizeUsd = this.toCash((o.tokens * q.priceUsdPerToken) / E18);
      const margin = (sizeUsd * BigInt(this.cfg.marginBps ?? 5000)) / 10_000n;
      const dep = await executor.execute(sleeve, AccountExecutor.data([{ token: this.cfg.usdg, amount: margin }], runData(0, venueIdx, encodeAbiParameters([{ type: "uint256" }], [margin]))), [venueProof]);
      if (!dep.ok) throw new VenueError(this.name, null, `margin deposit rejected: ${dep.rejection.reason}`, dep.rejection);
      const args = encodeAbiParameters(
        [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [o.underlying, false, sizeUsd, margin, BigInt(o.maxSlippageBps)],
      );
      const r = await executor.execute(sleeve, AccountExecutor.data([], runData(2, venueIdx, args)), [venueProof]);
      if (!r.ok) throw new VenueError(this.name, null, `open rejected: ${r.rejection.reason}`, r.rejection);
      const after = await this.pub.readContract({ address: market, abi: marketAbi, functionName: "position", args: [this.cfg.venue] });
      // The fill is whatever the market booked (size in cash units / price), not the tokens asked for.
      return { id: r.tx, status: "filled", tokens: after.tokens - pos.tokens, side: "sell", underlying: o.underlying };
    }
    if (o.side === "buy" && o.reduceOnly) {
      if (pos.size === 0n || pos.isLong) throw new VenueError(this.name, null, "no short to reduce");
      const tokens = o.tokens > pos.tokens ? pos.tokens : o.tokens;
      const sizeUsd = tokens === pos.tokens ? pos.size : (pos.size * tokens) / pos.tokens;
      const args = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [o.underlying, sizeUsd]);
      const r = await executor.execute(sleeve, AccountExecutor.data([], runData(3, venueIdx, args)));
      if (!r.ok) throw new VenueError(this.name, null, `reduce rejected: ${r.rejection.reason}`, r.rejection);
      const after = await this.pub.readContract({ address: market, abi: marketAbi, functionName: "position", args: [this.cfg.venue] });
      return { id: r.tx, status: "filled", tokens: pos.tokens - after.tokens, side: "buy", underlying: o.underlying };
    }
    throw new VenueError(this.name, null, "the hedge sleeve only opens shorts and reduces them");
  }
}

/** PerpSleeve.run data: (op, venueIdx, args). */
export function runData(op: number, idx: number, args: Hex): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "bytes" }], [op, BigInt(idx), args]);
}
