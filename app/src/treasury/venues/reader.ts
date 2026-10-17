// Bridges an off-chain venue client to the risk service's VenueReader, so the MirrorPusher can post the venue's
// own numbers to PositionMirror (controller-signed). `flowInSeen` is the MirroredPerpVenue's deposit counter the
// venue equity already includes; the operator reads it on-chain when the venue credits a deposit. `flowOutSeen` is
// the adapter's `flowOut()` (cash received back) the venue equity already excludes, read when the venue's
// withdrawal has landed at the adapter; until it is signed, the adapter itself nets the unseen return out.
import type { Address } from "viem";
import type { MirrorReading, VenueReader } from "@/treasury/risk/mirror";
import type { PerpVenueClient } from "./types";

export function asVenueReader(
  client: PerpVenueClient,
  venue: Address,
  flowInSeen: () => Promise<bigint>,
  flowOutSeen: () => Promise<bigint> = async () => 0n,
): VenueReader {
  return {
    venue,
    async read(): Promise<MirrorReading> {
      const [s, funding, seen, seenOut] = await Promise.all([client.statement(), client.funding(), flowInSeen(), flowOutSeen()]);
      if (s.unmapped?.length) throw new Error(`${client.name}: unmapped venue positions ${s.unmapped.join(",")}`);
      return { positions: s.positions, equityUsd: s.equityUsd, flowInSeen: seen, flowOutSeen: seenOut, funding };
    },
  };
}
