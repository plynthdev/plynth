// Pushes controller-signed PositionMirror snapshots for off-chain venues. A VenueReader turns a venue's API into
// (positions in Stock Token units, equity in USD 1e18, flowInSeen = the adapter's deposit counter the equity
// already includes). Real Orderly/Arcus readers are todo 29; StaticVenueReader serves tests and dry runs.
import { keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { positionMirrorAbi } from "@/abi/treasury-risk";
import { stringify } from "./webhooks";

export type MirrorPosition = { underlying: Address; tokens: bigint };

export type MirrorReading = {
  positions: MirrorPosition[];
  equityUsd: bigint;
  flowInSeen: bigint;
  /** Signed funding per underlying (1e18 fraction of size per second, > 0 longs pay), when the venue reports it. */
  funding?: { underlying: Address; ratePerSecond: bigint }[];
};

export interface VenueReader {
  readonly venue: Address; // the MirroredPerpVenue adapter address
  read(): Promise<MirrorReading>;
}

export class StaticVenueReader implements VenueReader {
  constructor(
    readonly venue: Address,
    public reading: MirrorReading,
  ) {}
  async read() {
    return this.reading;
  }
}

export const SNAPSHOT_TYPES = {
  Snapshot: [
    { name: "venue", type: "address" },
    { name: "positions", type: "Position[]" },
    { name: "equityUsd", type: "uint256" },
    { name: "flowInSeen", type: "uint256" },
    { name: "ts", type: "uint64" },
  ],
  Position: [
    { name: "underlying", type: "address" },
    { name: "tokens", type: "int256" },
  ],
} as const;

export function mirrorDomain(chainId: number, mirror: Address) {
  return { name: "Plinth PositionMirror", version: "1", chainId, verifyingContract: mirror } as const;
}

export type SignedSnapshot = {
  venue: Address;
  positions: MirrorPosition[];
  equityUsd: bigint;
  flowInSeen: bigint;
  ts: bigint;
  signature: Hex;
};

export async function signSnapshot(
  controller: PrivateKeyAccount,
  chainId: number,
  mirror: Address,
  venue: Address,
  r: MirrorReading,
  ts: bigint,
): Promise<SignedSnapshot> {
  const message = { venue, positions: r.positions, equityUsd: r.equityUsd, flowInSeen: r.flowInSeen, ts };
  const signature = await controller.signTypedData({ domain: mirrorDomain(chainId, mirror), types: SNAPSHOT_TYPES, primaryType: "Snapshot", message });
  return { ...message, signature };
}

/** Content fingerprint (not the EIP-712 digest): used to skip re-posting an unchanged reading too often. */
export const readingKey = (r: MirrorReading) => keccak256(new TextEncoder().encode(stringify([r.positions, r.equityUsd, r.flowInSeen])));

export type PushResult = { venue: Address; posted: boolean; ts?: bigint; tx?: Hex; reason?: string };

export class MirrorPusher {
  private lastKey = new Map<string, Hex>();

  constructor(
    readonly pub: PublicClient,
    readonly wallet: WalletClient,
    readonly controller: PrivateKeyAccount,
    readonly mirror: Address,
    /** Re-post an unchanged reading once the last snapshot is this old (must stay under the 10-minute stale bound). */
    readonly refreshSec = 60n,
  ) {
    if (refreshSec >= 600n) throw new Error("refreshSec must be below PositionMirror.STALE_AFTER (600 s)");
  }

  async push(reader: VenueReader): Promise<PushResult> {
    const reading = await reader.read();
    const [, , , lastTs] = await this.pub.readContract({ address: this.mirror, abi: positionMirrorAbi, functionName: "latest", args: [reader.venue] });
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const ts = block.timestamp;
    const key = readingKey(reading);
    const unchanged = this.lastKey.get(reader.venue.toLowerCase()) === key;
    if (unchanged && lastTs !== 0n && ts - lastTs < this.refreshSec) return { venue: reader.venue, posted: false, reason: "fresh" };
    if (ts <= lastTs) return { venue: reader.venue, posted: false, reason: "same-second" };
    const s = await signSnapshot(this.controller, await this.pub.getChainId(), this.mirror, reader.venue, reading, ts);
    const tx = await this.wallet.writeContract({
      address: this.mirror,
      abi: positionMirrorAbi,
      functionName: "post",
      args: [s.venue, s.positions, s.equityUsd, s.flowInSeen, s.ts, s.signature],
      account: this.wallet.account ?? this.controller,
      chain: this.wallet.chain,
    });
    const rc = await this.pub.waitForTransactionReceipt({ hash: tx });
    if (rc.status !== "success") return { venue: reader.venue, posted: false, tx, reason: "reverted" };
    this.lastKey.set(reader.venue.toLowerCase(), key);
    return { venue: reader.venue, posted: true, ts, tx };
  }
}
