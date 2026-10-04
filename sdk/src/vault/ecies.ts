// Encrypted notes: ECIES to the owner's x25519 viewing public key.
//   shared = x25519(ephemeralSecret, viewingPub)
//   key    = HKDF-SHA256(shared, salt = ephemeralPub || viewingPub, info = "plynth.note.v1", 32)
//   ct     = XChaCha20-Poly1305(key, nonce24).encrypt(asset(20) || raw(16) || blinding(32))
//   bytes  = 0x01 || ephemeralPub(32) || nonce(24) || ct(68 + 16)        = 141 bytes (pool max 512)
// A v2 note (a ShieldedTrade swap output, amount unknown when encrypted) uses version byte 0x02 and the same
// layout with raw = the proof's minimum; its real amount comes from ShieldedTrade's PartialNoteFilled event.
// The owner key is not inside: the reader recomputes the commitment with their own ownerPk, so a note that
// decrypts but is not theirs (or was tampered with) is rejected.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, getAddress, hexToBytes, type Hex } from "viem";
import { MAX_RAW, P, type Note } from "./note";

export const NOTE_VERSION = 1;
export const NOTE_VERSION_PARTIAL = 2;
export const ENCRYPTED_NOTE_BYTES = 1 + 32 + 24 + 68 + 16;
const INFO = new TextEncoder().encode("plynth.note.v1");

function key(shared: Uint8Array, eph: Uint8Array, pub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(eph, 0);
  salt.set(pub, 32);
  return hkdf(sha256, shared, salt, INFO, 32);
}

const be = (x: bigint, n: number) => hexToBytes(`0x${x.toString(16).padStart(n * 2, "0")}`);

export type NotePlain = Pick<Note, "asset" | "raw" | "blinding">;

export function encryptNote(note: NotePlain, viewingPub: Uint8Array, version: 1 | 2 = NOTE_VERSION): Hex {
  if (viewingPub.length !== 32) throw new Error("viewing public key must be 32 bytes");
  if (note.raw < 0n || note.raw > MAX_RAW) throw new Error("raw out of range");
  if (note.blinding < 0n || note.blinding >= P) throw new Error("blinding out of range");
  const ephSecret = x25519.utils.randomPrivateKey();
  const eph = x25519.getPublicKey(ephSecret);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const plain = new Uint8Array(68);
  plain.set(hexToBytes(getAddress(note.asset)), 0);
  plain.set(be(note.raw, 16), 20);
  plain.set(be(note.blinding, 32), 36);
  const ct = xchacha20poly1305(key(x25519.getSharedSecret(ephSecret, viewingPub), eph, viewingPub), nonce).encrypt(plain);
  const out = new Uint8Array(ENCRYPTED_NOTE_BYTES);
  out[0] = version;
  out.set(eph, 1);
  out.set(nonce, 33);
  out.set(ct, 57);
  return bytesToHex(out);
}

/** Returns the plaintext of a v1 note, or null if this note was not encrypted to `viewingSecret` (or is malformed, or v2). */
export function decryptNote(data: Hex, viewingSecret: Uint8Array): NotePlain | null {
  const p = decryptNoteAny(data, viewingSecret);
  if (!p || p.version !== NOTE_VERSION) return null;
  return { asset: p.asset, raw: p.raw, blinding: p.blinding };
}

/** v1 or v2 note plaintext with its version (for v2, `raw` is only the proof's minimum). */
export function decryptNoteAny(data: Hex, viewingSecret: Uint8Array): (NotePlain & { version: 1 | 2 }) | null {
  let b: Uint8Array;
  try {
    b = hexToBytes(data);
  } catch {
    return null;
  }
  if (b.length !== ENCRYPTED_NOTE_BYTES || (b[0] !== NOTE_VERSION && b[0] !== NOTE_VERSION_PARTIAL)) return null;
  const version = b[0] as 1 | 2;
  const eph = b.slice(1, 33);
  const nonce = b.slice(33, 57);
  const pub = x25519.getPublicKey(viewingSecret);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key(x25519.getSharedSecret(viewingSecret, eph), eph, pub), nonce).decrypt(b.slice(57));
  } catch {
    return null;
  }
  const big = (x: Uint8Array) => BigInt(bytesToHex(x));
  const blinding = big(plain.slice(36, 68));
  if (blinding >= P) return null;
  return { asset: getAddress(bytesToHex(plain.slice(0, 20))), raw: big(plain.slice(20, 36)), blinding, version };
}
