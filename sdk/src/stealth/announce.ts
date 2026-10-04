// ERC-5564 announcements and the ERC-6538 registry: calldata builders, metadata layout, and the scanner.
import { concat, decodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiItem, size, slice, toHex, type Address, type Hex } from "viem";
import { contracts } from "@plynth/chain";
import { checkStealthAddress, parseMetaAddress, SCHEME_ID, stealthPrivateKey } from "./crypto";

/** Canonical singletons (same address on every chain; defaults from @plynth/chain). Pass your own to override. */
export const ERC5564_ANNOUNCER: Address = contracts.mainnet.erc5564Announcer;
export const ERC6538_REGISTRY: Address = contracts.mainnet.erc6538Registry;

export const registryAbi = parseAbi([
  "function registerKeys(uint256 schemeId, bytes stealthMetaAddress)",
  "function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)",
  "event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress)",
]);

export const announcerAbi = parseAbi([
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)",
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
]);

export const announcementEvent = parseAbiItem(
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
);

/** ERC-20 `transfer(address,uint256)` selector: the function identifier CrowdBuy puts in token metadata. */
export const TRANSFER_SELECTOR: Hex = "0xa9059cbb";

/** ERC-6538 `registerKeys(1, meta)` as an unsigned transaction for the user's wallet to send. */
export function registerTx(meta: string, registry: Address = ERC6538_REGISTRY): { to: Address; data: Hex; value: 0n } {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(meta);
  return {
    to: registry,
    data: encodeFunctionData({ abi: registryAbi, functionName: "registerKeys", args: [SCHEME_ID, concat([spendingPublicKey, viewingPublicKey])] }),
    value: 0n,
  };
}

/** viewTag (1) | selector (4) | token (20) | amount (32) = 57 bytes, per ERC-5564's token guideline. */
export function encodeMetadata(viewTag: Hex, token: Address, amount: bigint, selector: Hex = TRANSFER_SELECTOR): Hex {
  if (size(viewTag) !== 1) throw new Error("view tag is one byte");
  return concat([viewTag, selector, getAddress(token), toHex(amount, { size: 32 })]).toLowerCase() as Hex;
}

export function decodeMetadata(metadata: Hex): { viewTag: number; selector?: Hex; token?: Address | undefined; amount?: bigint | undefined } {
  if (size(metadata) < 1) throw new Error("empty metadata");
  const viewTag = Number(BigInt(slice(metadata, 0, 1)));
  if (size(metadata) < 57) return { viewTag };
  return {
    viewTag,
    selector: slice(metadata, 1, 5),
    token: getAddress(slice(metadata, 5, 25)),
    amount: BigInt(slice(metadata, 25, 57)),
  };
}

export type Announcement = {
  schemeId: bigint;
  stealthAddress: Address;
  caller: Address;
  ephemeralPublicKey: Hex;
  metadata: Hex;
  blockNumber?: bigint | undefined;
  transactionHash?: Hex | undefined;
  logIndex?: number | undefined;
};

export type ScanHit = Announcement & { viewTag: number; token?: Address | undefined; amount?: bigint | undefined };

/**
 * Returns the announcements addressed to the holder of (viewingPrivateKey, spendingPublicKey).
 * Only scheme 1 is considered. `callers` optionally restricts to trusted announcers (e.g. CrowdBuy) to skip spam.
 */
export function scan(
  announcements: Announcement[],
  viewingPrivateKey: Hex,
  spendingPublicKey: Hex,
  opts: { callers?: Address[] } = {},
): ScanHit[] {
  const callers = opts.callers?.map((c) => c.toLowerCase());
  const out: ScanHit[] = [];
  for (const a of announcements) {
    if (a.schemeId !== SCHEME_ID) continue;
    if (callers && !callers.includes(a.caller.toLowerCase())) continue;
    let meta: ReturnType<typeof decodeMetadata>;
    try {
      meta = decodeMetadata(a.metadata);
    } catch {
      continue;
    }
    if (!checkStealthAddress({ stealthAddress: a.stealthAddress, ephemeralPublicKey: a.ephemeralPublicKey, viewTag: meta.viewTag, viewingPrivateKey, spendingPublicKey })) continue;
    out.push({ ...a, viewTag: meta.viewTag, token: meta.token, amount: meta.amount });
  }
  return out;
}

/** Decodes raw `eth_getLogs` entries from the announcer into Announcements. */
export function decodeAnnouncementLog(log: { topics: readonly Hex[]; data: Hex; blockNumber?: bigint | null | undefined; transactionHash?: Hex | null | undefined; logIndex?: number | null | undefined }): Announcement {
  const [ephemeralPublicKey, metadata] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], log.data);
  return {
    schemeId: BigInt(log.topics[1]!),
    stealthAddress: getAddress(`0x${log.topics[2]!.slice(-40)}`),
    caller: getAddress(`0x${log.topics[3]!.slice(-40)}`),
    ephemeralPublicKey,
    metadata,
    blockNumber: log.blockNumber ?? undefined,
    transactionHash: log.transactionHash ?? undefined,
    logIndex: log.logIndex ?? undefined,
  };
}

/** Private key of a scanned hit (for signing its claim). */
export function keyForHit(hit: Pick<Announcement, "ephemeralPublicKey" | "stealthAddress">, keys: { viewingPrivateKey: Hex; spendingPrivateKey: Hex }): Hex {
  return stealthPrivateKey({ ephemeralPublicKey: hit.ephemeralPublicKey, stealthAddress: hit.stealthAddress, ...keys });
}
