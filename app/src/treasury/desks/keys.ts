// Desk keys come from the environment, never from the config file:
//   <PREFIX>_KEY                    hex private key (dev / CI)
//   <PREFIX>_KEYSTORE + _PASSWORD   an encrypted Web3 v3 keystore (what `cast wallet new/import` writes),
//     or _PASSWORD_FILE             with the password in a file
// The key is decrypted in-process (scrypt or pbkdf2 + aes-128-ctr) and never printed.
import type { Env } from "@/config";
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from "viem";
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

const strip = (h: string) => h.replace(/^0x/, "");

export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json) as Keystore;
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new Error("keystore: no crypto section");
  if (c.cipher !== "aes-128-ctr") throw new Error(`keystore: unsupported cipher ${c.cipher}`);
  const salt = Buffer.from(strip(c.kdfparams.salt), "hex");
  const pw = Buffer.from(password.normalize("NFKD"), "utf8");
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    const { n = 0, r = 8, p = 1, dklen } = c.kdfparams;
    dk = scryptSync(pw, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (c.kdfparams.prf !== "hmac-sha256") throw new Error(`keystore: unsupported prf ${c.kdfparams.prf}`);
    dk = pbkdf2Sync(pw, salt, c.kdfparams.c ?? 0, c.kdfparams.dklen, "sha256");
  } else {
    throw new Error(`keystore: unsupported kdf ${(c as { kdf: string }).kdf}`);
  }
  const ct = Buffer.from(strip(c.ciphertext), "hex");
  const mac = keccak256(concat([bytesToHex(dk.subarray(16, 32)), bytesToHex(ct)]));
  if (strip(mac).toLowerCase() !== strip(c.mac).toLowerCase()) throw new Error("keystore: wrong password (MAC mismatch)");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(strip(c.cipherparams.iv), "hex"));
  const pk = Buffer.concat([d.update(ct), d.final()]);
  if (pk.length !== 32) throw new Error("keystore: decrypted key is not 32 bytes");
  return bytesToHex(new Uint8Array(pk));
}

/** Loads the desk account for `prefix` (e.g. TREASURY_CASH_DESK) from `env`. */
export function loadDeskAccount(prefix: string, env: Env): PrivateKeyAccount {
  const raw = env[`${prefix}_KEY`];
  if (raw) {
    const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (hexToBytes(hex).length !== 32) throw new Error(`${prefix}_KEY is not a 32-byte hex key`);
    return privateKeyToAccount(hex);
  }
  const file = env[`${prefix}_KEYSTORE`];
  if (file) {
    let password = env[`${prefix}_KEYSTORE_PASSWORD`];
    const pwFile = env[`${prefix}_KEYSTORE_PASSWORD_FILE`];
    if (password === undefined && pwFile) password = readFileSync(pwFile, "utf8").replace(/\r?\n$/, "");
    if (password === undefined) throw new Error(`${prefix}_KEYSTORE is set but neither _KEYSTORE_PASSWORD nor _KEYSTORE_PASSWORD_FILE`);
    return privateKeyToAccount(decryptKeystore(readFileSync(file, "utf8"), password));
  }
  throw new Error(`no key for ${prefix}: set ${prefix}_KEY or ${prefix}_KEYSTORE (+ _KEYSTORE_PASSWORD[_FILE])`);
}
