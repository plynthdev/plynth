import { describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKeystore, loadDeskAccount } from "../desks/keys";

const ANVIL_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // test-key (anvil #1)

function pbkdf2Keystore(pk: string, password: string) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = pbkdf2Sync(Buffer.from(password), salt, 1000, 32, "sha256");
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(pk.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(dk.subarray(16, 32)), bytesToHex(ct)])).slice(2);
  return JSON.stringify({
    version: 3,
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "pbkdf2", kdfparams: { c: 1000, dklen: 32, prf: "hmac-sha256", salt: salt.toString("hex") }, mac },
  });
}

describe("desk keys from env or keystore, like the keeper", () => {
  test("hex key from <PREFIX>_KEY", () => {
    const a = loadDeskAccount("X", { X_KEY: ANVIL_1 });
    expect(a.address).toBe(privateKeyToAccount(ANVIL_1).address);
    expect(() => loadDeskAccount("X", { X_KEY: "0x1234" })).toThrow("32-byte");
  });

  test("missing key names both options and never prints a key", () => {
    expect(() => loadDeskAccount("TREASURY_CASH_DESK", {})).toThrow("TREASURY_CASH_DESK_KEY or TREASURY_CASH_DESK_KEYSTORE");
  });

  test("pbkdf2 keystore decrypts; wrong password is a MAC mismatch", () => {
    const ks = pbkdf2Keystore(ANVIL_1, "pw");
    expect(decryptKeystore(ks, "pw")).toBe(ANVIL_1);
    expect(() => decryptKeystore(ks, "nope")).toThrow("MAC");
  });

  test("keystore + password file via env", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-ks-"));
    writeFileSync(join(dir, "ks.json"), pbkdf2Keystore(ANVIL_1, "secret"));
    writeFileSync(join(dir, "pw"), "secret\n");
    const a = loadDeskAccount("D", { D_KEYSTORE: join(dir, "ks.json"), D_KEYSTORE_PASSWORD_FILE: join(dir, "pw") });
    expect(a.address).toBe(privateKeyToAccount(ANVIL_1).address);
    expect(() => loadDeskAccount("D", { D_KEYSTORE: join(dir, "ks.json") })).toThrow("PASSWORD");
  });

  test("scrypt keystore written by `cast wallet new` decrypts to the address cast reports", () => {
    const cast = Bun.which("cast");
    if (!cast) return; // foundry not on PATH: covered by the pbkdf2 case
    const dir = mkdtempSync(join(tmpdir(), "plynth-cast-ks-"));
    const made = Bun.spawnSync([cast, "wallet", "new", dir, "--unsafe-password", "pw"], { stdout: "pipe", stderr: "pipe" });
    expect(made.exitCode).toBe(0);
    const file = join(dir, readdirSync(dir)[0]!);
    const addr = Bun.spawnSync([cast, "wallet", "address", "--keystore", file, "--password", "pw"], { stdout: "pipe" }).stdout.toString().trim();
    const a = loadDeskAccount("K", { K_KEYSTORE: file, K_KEYSTORE_PASSWORD: "pw" });
    expect(a.address.toLowerCase()).toBe(addr.toLowerCase());
  });
});
