// Hidden Vault keys from one wallet signature (deterministic, so a user can always re-derive them):
//   spendingSecret = HKDF-SHA256(sig, salt, "spend", 64 bytes) mod p    -> ownerPk = Poseidon2(spendingSecret)
//   viewingSecret  = HKDF-SHA256(sig, salt, "view", 32 bytes)           -> x25519 viewing keypair
// The viewing key decrypts notes (and can be shared for statements); only the spending secret can spend.
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes, isHex, type Hex } from "viem";
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

/** What a user registers in the SavingsVault for Hidden delivery (setHiddenKeys). */
export function registration(k: VaultKeys): { ownerPk: Hex; viewingPub: Hex } {
  return {
    ownerPk: `0x${k.ownerPk.toString(16).padStart(64, "0")}`,
    viewingPub: `0x${Buffer.from(k.viewingPub).toString("hex")}`,
  };
}
