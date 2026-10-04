// Round-up sources beyond on-chain spends (todo 23). Every source yields SpendEvents; the keeper turns each
// into one vault.accrue. The vault, not the keeper, computes the round-up and enforces the weekly cap and
// replay protection, so a buggy or hostile source can at most move a user's own available balance to
// pending, bounded by the user's own weekly cap.
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";

export type SourceName = "onchain" | "statement" | "plaid";

export type SpendEvent = {
  /** Unique within (source, user): statement row hash, Plaid transaction_id, or "<txHash>:<logIndex>". */
  id: string;
  /** Spend in cents of `currency`, always positive (money out). */
  amountCents: bigint;
  currency: string;
  at: Date;
  merchant?: string;
  /** Exact USDG base units when the source has them (on-chain spends are not whole cents). */
  units?: bigint;
};

export interface SpendSource {
  readonly name: SourceName;
  /** Spends of `user` at or after `since` that the keeper has not finished with yet. */
  fetch(user: Address, since: Date): Promise<SpendEvent[]>;
}

/** USDG has 6 decimals: 1 cent = 10_000 base units. */
export const UNITS_PER_CENT = 10_000n;

export function usdgUnits(e: Pick<SpendEvent, "amountCents" | "units">): bigint {
  return e.units ?? e.amountCents * UNITS_PER_CENT;
}

/**
 * The bytes32 passed to vault.accrue(user, key, 0, amount) for an off-chain spend. The user is part of the
 * key because the vault's replay guard is global: two users importing an identical statement line must not
 * collide (the first would make the second AlreadyAccrued).
 */
export function accrualKey(source: SourceName, user: Address, id: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "string" }], [source, getAddress(user), id]));
}

/** Hex sha256 (no 0x) of a UTF-8 string. */
export function sha256Hex(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}
