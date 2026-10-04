// Bridges an off-chain venue client to the risk service's VenueReader, so the MirrorPusher can post the venue's
// own numbers to PositionMirror (controller-signed). `flowInSeen` is the MirroredPerpVenue's deposit counter the
// venue equity already includes; the operator reads it on-chain when the venue credits a deposit.
import type { Address } from "viem";
import type { MirrorReading, VenueReader } from "../risk/mirror";
import type { PerpVenueClient } from "./types";

export function asVenueReader(client: PerpVenueClient, venue: Address, flowInSeen: () => Promise<bigint>): VenueReader {
  return {
    venue,
    async read(): Promise<MirrorReading> {
      const [s, funding, seen] = await Promise.all([client.statement(), client.funding(), flowInSeen()]);
      if (s.unmapped?.length) throw new Error(`${client.name}: unmapped venue positions ${s.unmapped.join(",")}`);
      return { positions: s.positions, equityUsd: s.equityUsd, flowInSeen: seen, funding };
    },
  };
}
