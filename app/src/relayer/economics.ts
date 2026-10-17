// Relayer economics (review v2, V2-L17 / REL-3). The relayer pays gas and is paid in the proven relayerFee, so every
// relayed transaction must pay for itself at the gas price it is actually sent at:
//   - the fee's USD value (USDG at $1, a Stock Token at its Chainlink feed, a park share at ShieldedTrade.parkValue)
//     must cover gas estimate x current gas price x RELAYER_ETH_USD, plus RELAYER_FEE_MARGIN_BPS; else refused, with
//     the fee that would be enough;
//   - nothing is sent while the gas price is above RELAYER_MAX_FEE_PER_GAS_WEI, and every transaction carries that
//     cap as its maxFeePerGas, so a spike after the check cannot overspend;
//   - a swap is charged for its settle too (ShieldedTrade.settle carries no fee): /swap returns a single-use settle
//     ticket, and /settle is relayed only with one. A buy + settle used to cost ~9M gas for one 0.25 USDG fee.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Address } from "viem";

/** Gas the relayer budgets for a settle that a swap's fee prepays (verify + one insert; measured ~3.85M). */
export const SETTLE_GAS = 4_200_000n;
export const DEFAULT_MAX_FEE_PER_GAS_WEI = 100_000_000n; // 0.1 gwei
export const DEFAULT_ETH_USD = 5_000;
export const DEFAULT_FEE_MARGIN_BPS = 1_000;

export type EconomicsConfig = { maxFeePerGasWei: bigint; ethUsd: number; marginBps: number };

export type EconomicsDeps = {
  gasPrice: () => Promise<bigint>;
  /** USD value of `raw` units of `asset` in micro-USD (1e-6 USD); undefined = no price, not relayed. */
  valueMicroUsd: (asset: Address, raw: bigint) => Promise<bigint | undefined>;
};

export type FeeVerdict = { ok: true; maxFeePerGas: bigint } | { ok: false; status: 400 | 503; error: string };

export class Economics {
  constructor(
    readonly cfg: EconomicsConfig,
    private readonly d: EconomicsDeps,
  ) {}

  /** Micro-USD the relayer spends on `gas` at `gasPrice`, with the margin. */
  costMicroUsd(gas: bigint, gasPrice: bigint): bigint {
    const wei = gas * gasPrice;
    const micro = (wei * BigInt(Math.round(this.cfg.ethUsd * 1e6))) / 10n ** 18n;
    return (micro * BigInt(10_000 + this.cfg.marginBps) + 9_999n) / 10_000n;
  }

  /** Only the gas-price cap (a prepaid settle). */
  async gasOk(): Promise<{ ok: true } | { ok: false; status: 503; error: string }> {
    const price = await this.d.gasPrice();
    return price > this.cfg.maxFeePerGasWei ? { ok: false, status: 503, error: `gas price ${price} wei is above the relayer's cap (${this.cfg.maxFeePerGasWei}); try again later` } : { ok: true };
  }

  /** Is `fee` of `asset` worth `gas` (plus `extraGas`, e.g. the settle a swap prepays) at the current gas price? */
  async check(asset: Address, fee: bigint, gas: bigint, extraGas = 0n): Promise<FeeVerdict> {
    const price = await this.d.gasPrice();
    if (price > this.cfg.maxFeePerGasWei) return { ok: false, status: 503, error: `gas price ${price} wei is above the relayer's cap (${this.cfg.maxFeePerGasWei}); try again later` };
    const value = await this.d.valueMicroUsd(asset, fee);
    if (value === undefined) return { ok: false, status: 400, error: "no price for this fee asset: send it from your own wallet" };
    const cost = this.costMicroUsd(gas + extraGas, price);
    if (value < cost) {
      // the fee in asset units that would be enough, for the error: scale the offered fee by cost / value
      const need = value === 0n ? undefined : (fee * cost + value - 1n) / value;
      return { ok: false, status: 400, error: `relayerFee is worth ${value} micro-USD but the transaction costs ${cost} at ${price} wei/gas${need ? `; a fee of at least ${need} is needed` : ""}` };
    }
    return { ok: true, maxFeePerGas: this.cfg.maxFeePerGasWei };
  }
}

/**
 * Single-use settle tickets: `<expiry>.<id>.<hmac>`. One per relayed swap, so the relayer relays at most as many
 * settles as swaps it was paid for. Used ids are remembered until they expire (in memory: after a restart a ticket
 * issued before it could be used once more, bounded by the paid swaps and the expiry).
 */
export class SettleTickets {
  private readonly used = new Map<string, number>();
  constructor(
    private readonly key: Buffer = randomBytes(32),
    private readonly ttlS = 7 * 86_400,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private mac(body: string) {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  issue(): string {
    const body = `${this.now() + this.ttlS}.${randomBytes(16).toString("hex")}`;
    return `${body}.${this.mac(body)}`;
  }

  /** Checks and burns a ticket. Returns an error message, or undefined when the ticket was good. */
  redeem(ticket: unknown): string | undefined {
    if (typeof ticket !== "string" || ticket.length > 200) return "a settle ticket is required (returned by the relayed swap); or settle from your own wallet";
    const [exp, id, mac] = ticket.split(".");
    if (!exp || !id || !mac || !/^\d+$/.test(exp) || !/^[0-9a-f]{32}$/.test(id)) return "malformed settle ticket";
    const want = Buffer.from(this.mac(`${exp}.${id}`));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return "invalid settle ticket";
    const t = this.now();
    if (Number(exp) < t) return "settle ticket expired";
    for (const [k, e] of this.used) if (e < t) this.used.delete(k);
    if (this.used.has(id)) return "settle ticket already used";
    this.used.set(id, Number(exp));
    return undefined;
  }

  /** Gives a ticket back (the settle it was burnt for was refused before sending). */
  release(ticket: string) {
    this.used.delete(ticket.split(".")[1] ?? "");
  }
}
