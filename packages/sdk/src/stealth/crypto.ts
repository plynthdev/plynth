// ERC-5564 scheme 1 (secp256k1 with view tags), exactly as the ERC's reference notebook computes it:
//   shared secret  s   = p_ephemeral * P_view          (= p_view * P_ephemeral)
//   hashed secret  s_h = keccak256(x(s) || y(s))       (64 bytes, uncompressed point without the 0x04 prefix)
//   view tag       v   = s_h[0]
//   stealth pubkey P   = P_spend + (s_h mod n) * G
//   stealth key    p   = (p_spend + s_h) mod n
// Meta-address: 33-byte compressed spending key || 33-byte compressed viewing key ("st:eth:0x<66 bytes>").
//
// Note: @scopelift/stealth-address-sdk was tried first (todo 09 prefers it) but it does NOT reproduce the
// ERC's reference vector (for the notebook's keys it derives 0x7a76…E7D9 / view tag 0x63 instead of
// 0xfed6…32bb / 0x56), so this module implements the spec directly with @noble/curves. See test/stealth.test.ts.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

export const SCHEME_ID = 1n;

export type StealthKeys = {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex; // 33-byte compressed
  viewingPublicKey: Hex; // 33-byte compressed
};

export type GeneratedStealth = {
  stealthAddress: Address;
  ephemeralPublicKey: Hex; // 33-byte compressed
  viewTag: Hex; // one byte, e.g. "0x56"
};

/**
 * The message a wallet signs once to derive its stealth keys. Signing the same message again with the same
 * wallet gives the same keys only for deterministic (RFC 6979) signers, which every mainstream EOA wallet is.
 * Smart-contract wallets and hardware wallets that randomise nonces must store the keys instead.
 */
export const KEY_DERIVATION_MESSAGE =
  "Sign this message to create your Plynth Quiet keys.\n\nOnly sign this on the Plynth app. Anyone with this signature can see and spend your Quiet deliveries.\n\nVersion: 1";

const to32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;
const scalar = (h: Hex): bigint => BigInt(h) % N;

function privToScalar(priv: Hex): bigint {
  const k = BigInt(priv);
  if (k <= 0n || k >= N) throw new Error("private key out of range");
  return k;
}

/** 33-byte compressed public key of a private key. */
export function publicKeyOf(priv: Hex): Hex {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(to32(privToScalar(priv))), true));
}

/**
 * Deterministic spending/viewing keys from a 65-byte wallet signature (r || s || v) over
 * KEY_DERIVATION_MESSAGE: spending = keccak256(r) mod n, viewing = keccak256(s) mod n. Same split as Umbra
 * and the ScopeLift SDK, so the keys are portable between apps that use the same message.
 */
export function generateKeys(seedSig: Hex): StealthKeys {
  const b = hexToBytes(seedSig);
  if (b.length !== 65) throw new Error("seed signature must be 65 bytes (r || s || v)");
  const spend = scalar(keccak256(b.slice(0, 32)));
  const view = scalar(keccak256(b.slice(32, 64)));
  if (spend === 0n || view === 0n) throw new Error("degenerate signature");
  return keysFromPrivate(to32(spend), to32(view));
}

export function keysFromPrivate(spendingPrivateKey: Hex, viewingPrivateKey: Hex): StealthKeys {
  return {
    spendingPrivateKey: to32(privToScalar(spendingPrivateKey)),
    viewingPrivateKey: to32(privToScalar(viewingPrivateKey)),
    spendingPublicKey: publicKeyOf(spendingPrivateKey),
    viewingPublicKey: publicKeyOf(viewingPrivateKey),
  };
}

/** The 66 raw bytes registered in ERC-6538: spendingPub || viewingPub. */
export function metaAddressBytes(keys: Pick<StealthKeys, "spendingPublicKey" | "viewingPublicKey">): Hex {
  return `0x${keys.spendingPublicKey.slice(2)}${keys.viewingPublicKey.slice(2)}`;
}

/** "st:eth:0x<spendingPub><viewingPub>" */
export function metaAddress(keys: Pick<StealthKeys, "spendingPublicKey" | "viewingPublicKey">): string {
  return `st:eth:${metaAddressBytes(keys)}`;
}

/** Accepts "st:eth:0x…", "st:<chain>:0x…" or raw 66-byte hex. Validates both points. */
export function parseMetaAddress(meta: string): { spendingPublicKey: Hex; viewingPublicKey: Hex } {
  const hex = (meta.startsWith("st:") ? meta.slice(meta.lastIndexOf(":") + 1) : meta) as Hex;
  const b = hexToBytes(hex);
  if (b.length !== 66) throw new Error("stealth meta-address must be 66 bytes (two compressed keys)");
  const spendingPublicKey = bytesToHex(b.slice(0, 33));
  const viewingPublicKey = bytesToHex(b.slice(33));
  Point.fromHex(spendingPublicKey.slice(2)).assertValidity();
  Point.fromHex(viewingPublicKey.slice(2)).assertValidity();
  return { spendingPublicKey, viewingPublicKey };
}

function hashedSecret(priv: bigint, pub: Hex): Hex {
  const shared = Point.fromHex(pub.slice(2)).multiply(priv).toRawBytes(false); // 65 bytes, 0x04 || x || y
  return keccak256(shared.slice(1));
}

function pointToAddress(p: InstanceType<typeof Point>): Address {
  const raw = p.toRawBytes(false).slice(1);
  return getAddress(`0x${keccak256(raw).slice(-40)}`);
}

function stealthPoint(spendingPublicKey: Hex, sh: Hex): InstanceType<typeof Point> {
  const k = scalar(sh);
  const spend = Point.fromHex(spendingPublicKey.slice(2));
  return k === 0n ? spend : spend.add(Point.BASE.multiply(k));
}

/**
 * Sender side: a fresh stealth address for `meta`. Pass `ephemeralPrivateKey` only in tests; by default a
 * new random one is drawn and never returned (nobody needs it after this call).
 */
export function computeStealthAddress(meta: string, ephemeralPrivateKey?: Hex): GeneratedStealth {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(meta);
  const eph = ephemeralPrivateKey ? privToScalar(ephemeralPrivateKey) : BigInt(bytesToHex(secp256k1.utils.randomPrivateKey()));
  const sh = hashedSecret(eph, viewingPublicKey);
  return {
    stealthAddress: pointToAddress(stealthPoint(spendingPublicKey, sh)),
    ephemeralPublicKey: bytesToHex(Point.BASE.multiply(eph).toRawBytes(true)),
    viewTag: `0x${sh.slice(2, 4)}`,
  };
}

/**
 * Recipient side (needs only the viewing PRIVATE key and the spending PUBLIC key, so it can run on a
 * watch-only device). `viewTag` short-circuits 255 of 256 foreign announcements.
 */
export function checkStealthAddress(args: {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag?: Hex | number;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
}): boolean {
  let sh: Hex;
  try {
    sh = hashedSecret(privToScalar(args.viewingPrivateKey), args.ephemeralPublicKey);
  } catch {
    return false; // malformed ephemeral key in someone else's announcement
  }
  if (args.viewTag !== undefined) {
    const tag = typeof args.viewTag === "number" ? args.viewTag : Number(BigInt(args.viewTag));
    if (Number.parseInt(sh.slice(2, 4), 16) !== tag) return false;
  }
  return pointToAddress(stealthPoint(args.spendingPublicKey, sh)) === getAddress(args.stealthAddress);
}

/** p_stealth = (p_spend + s_h) mod n. Throws if it does not control `stealthAddress` when one is given. */
export function stealthPrivateKey(args: {
  ephemeralPublicKey: Hex;
  viewingPrivateKey: Hex;
  spendingPrivateKey: Hex;
  stealthAddress?: Address;
}): Hex {
  const sh = hashedSecret(privToScalar(args.viewingPrivateKey), args.ephemeralPublicKey);
  const k = (privToScalar(args.spendingPrivateKey) + BigInt(sh)) % N;
  if (k === 0n) throw new Error("degenerate stealth key");
  const key = to32(k);
  if (args.stealthAddress && pointToAddress(Point.BASE.multiply(k)) !== getAddress(args.stealthAddress)) {
    throw new Error("keys do not control this stealth address");
  }
  return key;
}

export function addressOfPrivateKey(priv: Hex): Address {
  return pointToAddress(Point.BASE.multiply(privToScalar(priv)));
}
