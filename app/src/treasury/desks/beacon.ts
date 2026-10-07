// JitterBeacon timing for the equity desk: one commit/reveal per window (1 day by default; the desk config's
// beaconWindowSeconds sets it, e.g. 2 hours on testnet, and must exceed the beacon's GRACE). The desk commits
// for the next window [start, start + window) before it opens, reveals once it is open, and rebalances once
// `executeAfter(key)` has passed (the beacon falls back to windowEnd - GRACE if nobody reveals).
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

export const DAY = 86_400n;
/** Default desk window when the config names none (mainnet/fork). */
export const DEFAULT_DESK_WINDOW = DAY;
export const BEACON_TAG: Hex = toHex("plynth.treasury.equity-rebalance", { size: 32 });

/** Start of the window holding `ts` on a grid of `window` seconds from the epoch (UTC midnight for 1 day). */
export function windowStart(ts: bigint, window: bigint = DEFAULT_DESK_WINDOW): bigint {
  return (ts / window) * window;
}

export function dayStart(ts: bigint): bigint {
  return windowStart(ts, DAY);
}

/** One beacon key per (account, window start). */
export function beaconKey(account: Address, day: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint64" }], [account, BEACON_TAG, day]));
}

/** commitment = keccak256(abi.encode(secret, key)), as JitterBeacon checks it. */
export function commitmentOf(secret: Hex, key: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [secret, key]));
}

/** A secret the desk can re-derive after a restart without storing it: hash of its own signature over the
 *  key (RFC 6979 signatures are deterministic). Nobody without the desk key can predict it. */
export async function secretFor(sign: (key: Hex) => Promise<Hex>, key: Hex): Promise<Hex> {
  return keccak256(await sign(key));
}

export type BeaconState = { windowStart: bigint; windowEnd: bigint; executeAt: bigint; commitment: Hex };

export { offsetOf } from "@/keeper/jobs/beacon";

export type BeaconStep =
  | { kind: "commit"; key: Hex; windowStart: bigint; windowEnd: bigint }
  | { kind: "reveal"; key: Hex };

/** What the desk should do with the beacon now: commit the next window, reveal the current one once its
 *  execution time (`revealAt` = windowStart + offsetOf(secret, ...)) has come; the beacon refuses earlier reveals. */
export function beaconSteps(now: bigint, grace: bigint, today: { key: Hex; b: BeaconState; revealAt?: bigint }, tomorrow: { key: Hex; b: BeaconState }, window: bigint = DEFAULT_DESK_WINDOW): BeaconStep[] {
  const steps: BeaconStep[] = [];
  const zero = /^0x0+$/;
  const t = today.b;
  const due = today.revealAt === undefined || now >= today.revealAt;
  if (!zero.test(t.commitment) && t.executeAt === 0n && due && now >= t.windowStart && now < t.windowEnd - grace) {
    steps.push({ kind: "reveal", key: today.key });
  }
  const start = windowStart(now, window) + window;
  if (zero.test(tomorrow.b.commitment) && now < start) {
    steps.push({ kind: "commit", key: tomorrow.key, windowStart: start, windowEnd: start + window });
  }
  return steps;
}
