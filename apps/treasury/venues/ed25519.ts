// Ed25519 with node:crypto only (no extra dependency): keys from a raw 32-byte seed, raw public keys, and the
// base58 encoding Orderly uses for keys ("ed25519:<base58>").
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), body]));
}

export type Ed25519Key = { privateKey: KeyObject; publicRaw: Uint8Array };

/** From a 32-byte seed given as 64 hex chars (optionally 0x-prefixed) or base58 (optionally "ed25519:"). */
export function keyFromSeed(seed: string | Uint8Array): Ed25519Key {
  let raw: Uint8Array;
  if (typeof seed !== "string") raw = seed;
  else {
    const s = seed.replace(/^ed25519:/, "").replace(/^0x/, "");
    raw = /^[0-9a-fA-F]{64}$/.test(s) ? new Uint8Array(Buffer.from(s, "hex")) : base58Decode(s);
  }
  if (raw.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicRaw: new Uint8Array(der.subarray(der.length - 32)) };
}

export function signBytes(key: Ed25519Key, msg: Uint8Array | string): Uint8Array {
  return new Uint8Array(edSign(null, typeof msg === "string" ? Buffer.from(msg) : msg, key.privateKey));
}

export function verifyBytes(publicRaw: Uint8Array, msg: Uint8Array | string, sig: Uint8Array): boolean {
  const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicRaw]), format: "der", type: "spki" });
  return edVerify(null, typeof msg === "string" ? Buffer.from(msg) : msg, pub, sig);
}
