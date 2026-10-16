// Hidden Vault keys from one wallet signature (deterministic, so a user can always re-derive them):
//   spendingSecret = HKDF-SHA256(sig, salt, "spend", 64 bytes) mod p    -> ownerPk = Poseidon2(spendingSecret)
//   viewingSecret  = HKDF-SHA256(sig, salt, "view", 32 bytes)           -> x25519 viewing keypair
// The viewing key decrypts notes (and can be shared for statements); only the spending secret can spend.
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { encodeFunctionData, getAddress, hexToBytes, isHex, parseAbi, type Address, type Hex } from "viem";
import { P, ownerPkOf } from "./note";

export const VAULT_KEY_MESSAGE =
  "Plynth Hidden Vault keys v1\n\nSigning this derives the keys for your shielded notes. Only sign it on a Plynth app you trust; anyone with this signature can spend your Hidden balance.";
const SALT = new TextEncoder().encode("plynth.hidden.keys.v1");

export type VaultKeys = {
  spendingSecret: bigint;
  ownerPk: bigint;
  viewingSecret: Uint8Array;
  viewingPub: Uint8Array;
};

const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));

/** Derives the vault keys from a 65-byte signature of VAULT_KEY_MESSAGE. Call initVault() first. */
export function deriveVaultKeys(signature: Hex): VaultKeys {
  if (!isHex(signature) || hexToBytes(signature).length !== 65) throw new Error("expected a 65-byte signature");
  const ikm = hexToBytes(signature);
  const spendingSecret = big(hkdf(sha256, ikm, SALT, "spend", 64)) % P;
  if (spendingSecret === 0n) throw new Error("degenerate spending secret");
  const viewingSecret = hkdf(sha256, ikm, SALT, "view", 32);
  return { spendingSecret, ownerPk: ownerPkOf(spendingSecret), viewingSecret, viewingPub: x25519.getPublicKey(viewingSecret) };
}

// Any clamped x25519 scalar is a multiple of the cofactor 8, so it sends every low-order point (and each
// non-canonical encoding of one) to the all-zero shared secret, which noble refuses. One fixed probe is enough.
const PROBE = new Uint8Array(32).fill(0x5a);

/**
 * Why (ownerPk, viewingPub) cannot receive Hidden notes, or null when they can. SavingsVault.setHiddenKeys accepts
 * any two words, so a low-order viewing key (no shared secret: a note cannot be encrypted to it) or an ownerPk outside
 * the field would make every note planned for that user throw. Checked by the SDK before registering, by the API
 * before building the transaction, and by the keeper before planning a note (audit M-6).
 */
export function hiddenKeysProblem(ownerPk: bigint | Hex, viewingPub: Uint8Array | Hex): string | null {
  let pk: bigint;
  try {
    pk = typeof ownerPk === "bigint" ? ownerPk : BigInt(ownerPk);
  } catch {
    return "ownerPk is not a number";
  }
  if (pk === 0n) return "no Hidden keys registered";
  if (pk < 0n || pk >= P) return "ownerPk is not a field element";
  let pub: Uint8Array;
  try {
    pub = typeof viewingPub === "string" ? hexToBytes(viewingPub) : viewingPub;
  } catch {
    return "viewingPub is not hex";
  }
  if (pub.length !== 32) return "viewingPub must be 32 bytes";
  try {
    const shared = x25519.getSharedSecret(PROBE, pub);
    if (shared.every((b) => b === 0)) return "viewingPub is a low-order x25519 point";
  } catch {
    return "viewingPub is a low-order x25519 point";
  }
  // RFC 7748 masks bit 255 and reduces mod p, so a non-canonical encoding names another key than the bytes the note's
  // HKDF salt binds: the owner (who derives the canonical key) could not open their notes.
  const u = BigInt(`0x${Buffer.from(pub).reverse().toString("hex")}`);
  if (u >= (1n << 255n) - 19n) return "viewingPub is not a canonical x25519 key";
  return null;
}

/** Throws when the keys cannot receive Hidden notes (see hiddenKeysProblem). */
export function assertHiddenKeys(ownerPk: bigint | Hex, viewingPub: Uint8Array | Hex): void {
  const problem = hiddenKeysProblem(ownerPk, viewingPub);
  if (problem) throw new Error(`invalid Hidden keys: ${problem}`);
}

/** What a user registers in the SavingsVault for Hidden delivery (setHiddenKeys). Refuses keys that cannot work. */
export function registration(k: VaultKeys): { ownerPk: Hex; viewingPub: Hex } {
  assertHiddenKeys(k.ownerPk, k.viewingPub);
  return {
    ownerPk: `0x${k.ownerPk.toString(16).padStart(64, "0")}`,
    viewingPub: `0x${Buffer.from(k.viewingPub).toString("hex")}`,
  };
}

const setHiddenKeysAbi = parseAbi(["function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)"]);

/** SavingsVault.setHiddenKeys(ownerPk, viewingPub) as an unsigned transaction; refuses low-order / out-of-field keys. */
export function setHiddenKeysTx(vault: Address, reg: { ownerPk: Hex; viewingPub: Hex }): { to: Address; data: Hex } {
  assertHiddenKeys(reg.ownerPk, reg.viewingPub);
  return { to: getAddress(vault), data: encodeFunctionData({ abi: setHiddenKeysAbi, functionName: "setHiddenKeys", args: [reg.ownerPk, reg.viewingPub] }) };
}
