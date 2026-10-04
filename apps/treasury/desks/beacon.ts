// JitterBeacon timing for the equity desk: one commit/reveal per day. The desk commits for tomorrow's window
// [day, day + 1 day) before it opens, reveals once it is open, and rebalances once `executeAfter(key)` has
// passed (the beacon falls back to windowEnd - GRACE if nobody reveals).
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

export const DAY = 86_400n;
export const BEACON_TAG: Hex = toHex("plynth.treasury.equity-rebalance", { size: 32 });

export function dayStart(ts: bigint): bigint {
  return (ts / DAY) * DAY;
}

/** One beacon key per (account, day). */
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

export type BeaconStep =
  | { kind: "commit"; key: Hex; windowStart: bigint; windowEnd: bigint }
  | { kind: "reveal"; key: Hex };

/** What the desk should do with the beacon now: commit tomorrow's window, reveal today's. */
export function beaconSteps(now: bigint, grace: bigint, today: { key: Hex; b: BeaconState }, tomorrow: { key: Hex; b: BeaconState }): BeaconStep[] {
  const steps: BeaconStep[] = [];
  const zero = /^0x0+$/;
  const t = today.b;
  if (!zero.test(t.commitment) && t.executeAt === 0n && now >= t.windowStart && now < t.windowEnd - grace) {
    steps.push({ kind: "reveal", key: today.key });
  }
  const start = dayStart(now) + DAY;
  if (zero.test(tomorrow.b.commitment) && now < start) {
    steps.push({ kind: "commit", key: tomorrow.key, windowStart: start, windowEnd: start + DAY });
  }
  return steps;
}
