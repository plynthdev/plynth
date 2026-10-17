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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
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
 * Where burnt ticket ids live between restarts (review v3 R3-SVC-3). The ticket key is derived from the relayer's own
 * key, so it is the same after a restart; with the used set in memory only, every ticket of the last 7 days could relay
 * one more settle after each restart (every deploy restarts the relayer).
 */
export interface TicketStore {
  /** Every id burnt and not yet expired, with its expiry (unix seconds). */
  load(now: number): Map<string, number>;
  burn(id: string, exp: number): void;
  release(id: string): void;
}

/**
 * An append-only file of `+<id> <exp>` / `-<id>` lines, synced on every write, compacted (expired ids dropped) when it
 * is loaded. One relayer process per file (the relayer runs once per host, systemd StateDirectory).
 */
export class FileTicketStore implements TicketStore {
  constructor(readonly path: string) {}

  load(now: number): Map<string, number> {
    const used = new Map<string, number>();
    if (!existsSync(this.path)) return used;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const burn = line.match(/^\+([0-9a-f]{32}) (\d+)$/);
      if (burn) used.set(burn[1]!, Number(burn[2]));
      const rel = line.match(/^-([0-9a-f]{32})$/);
      if (rel) used.delete(rel[1]!);
    }
    for (const [k, e] of used) if (e < now) used.delete(k);
    // Compact: write the live set to a temp file and rename it over the log (atomic on one filesystem).
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, [...used].map(([k, e]) => `+${k} ${e}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.path);
    return used;
  }

  private append(line: string) {
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd); // burnt before the settle is sent: a crash right after cannot make the ticket good again
    } finally {
      closeSync(fd);
    }
  }

  burn(id: string, exp: number) {
    this.append(`+${id} ${exp}\n`);
  }

  release(id: string) {
    this.append(`-${id}\n`);
  }
}

/**
 * Single-use settle tickets: `<expiry>.<id>.<hmac>`. One per relayed swap, so the relayer relays at most as many
 * settles as swaps it was paid for. Used ids are remembered until they expire, in `store` when one is given (the
 * relayer on testnet / mainnet), so a restart does not make a used ticket good again (R3-SVC-3).
 */
export class SettleTickets {
  private readonly used: Map<string, number>;
  constructor(
    private readonly key: Buffer = randomBytes(32),
    private readonly ttlS = 7 * 86_400,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly store?: TicketStore,
  ) {
    this.used = store ? store.load(this.now()) : new Map();
  }

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
    this.store?.burn(id, Number(exp)); // persisted first: if this throws, the ticket is not accepted
    this.used.set(id, Number(exp));
    return undefined;
  }

  /** Gives a ticket back (the settle it was burnt for was refused before sending). */
  release(ticket: string) {
    const id = ticket.split(".")[1] ?? "";
    if (!this.used.delete(id)) return;
    this.store?.release(id);
  }
}
