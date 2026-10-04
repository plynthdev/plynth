// The keeper's signing key: KEEPER_PRIVATE_KEY, or a Foundry keystore (KEEPER_KEYSTORE + KEEPER_KEYSTORE_PASSWORD_FILE).
// The key only ever lives in memory inside a viem LocalAccount. It is never logged, and errors from this
// module never include it.
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes, isHex, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

type Keystore = {
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto;
};
type KeystoreCrypto = {
  cipher: string;
  cipherparams: { iv: string };
  ciphertext: string;
  kdf: "scrypt" | "pbkdf2";
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
};

const unhex = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex");

/** Web3 Secret Storage v3 (what `cast wallet import` / `cast wallet new` write). Returns the raw key. */
export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json) as Keystore;
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new Error("keystore: no crypto section");
  if (c.cipher !== "aes-128-ctr") throw new Error(`keystore: unsupported cipher ${c.cipher}`);
  const kp = c.kdfparams;
  const salt = unhex(kp.salt);
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    const N = kp.n!, r = kp.r!, p = kp.p!;
    dk = scryptSync(Buffer.from(password, "utf8"), salt, kp.dklen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (kp.prf !== "hmac-sha256") throw new Error(`keystore: unsupported prf ${kp.prf}`);
    dk = pbkdf2Sync(Buffer.from(password, "utf8"), salt, kp.c!, kp.dklen, "sha256");
  } else {
    throw new Error(`keystore: unsupported kdf ${(c as { kdf: string }).kdf}`);
  }
  const ct = unhex(c.ciphertext);
  const mac = keccak256(new Uint8Array(Buffer.concat([dk.subarray(16, 32), ct])));
  if (mac.slice(2).toLowerCase() !== c.mac.replace(/^0x/, "").toLowerCase()) throw new Error("keystore: wrong password (MAC mismatch)");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), unhex(c.cipherparams.iv));
  const key = Buffer.concat([d.update(ct), d.final()]);
  if (key.length !== 32) throw new Error("keystore: decrypted key is not 32 bytes");
  return bytesToHex(new Uint8Array(key));
}

export type SignerEnv = {
  KEEPER_PRIVATE_KEY?: string | undefined;
  KEEPER_KEYSTORE?: string | undefined;
  KEEPER_KEYSTORE_PASSWORD_FILE?: string | undefined;
};

/** Builds the keeper account from env. Exactly one source must be configured. */
export function loadSigner(env: SignerEnv): PrivateKeyAccount {
  const pk = env.KEEPER_PRIVATE_KEY?.trim();
  const ks = env.KEEPER_KEYSTORE?.trim();
  if (pk && ks) throw new Error("set KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE, not both");
  if (pk) {
    const k = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
    if (!isHex(k) || hexToBytes(k).length !== 32) throw new Error("KEEPER_PRIVATE_KEY is not a 32-byte hex key");
    return privateKeyToAccount(k);
  }
  if (ks) {
    if (!env.KEEPER_KEYSTORE_PASSWORD_FILE) throw new Error("KEEPER_KEYSTORE needs KEEPER_KEYSTORE_PASSWORD_FILE");
    const password = readFileSync(env.KEEPER_KEYSTORE_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
    return privateKeyToAccount(decryptKeystore(readFileSync(ks, "utf8"), password));
  }
  throw new Error("no keeper key: set KEEPER_PRIVATE_KEY, or KEEPER_KEYSTORE + KEEPER_KEYSTORE_PASSWORD_FILE");
}
