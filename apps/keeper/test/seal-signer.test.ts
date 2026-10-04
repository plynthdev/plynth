import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "viem";
import { newSecret, parseSecretKey, Sealer } from "../src/seal";
import { decryptKeystore, loadSigner } from "../src/signer";
import { ANVIL_ADDR_1, ANVIL_KEY_1, hasBinary } from "./helpers";

const key32 = () => crypto.getRandomValues(new Uint8Array(32));

describe("beacon secret sealing (AES-GCM at rest)", () => {
  test("seal/open round-trips and never contains the plaintext", async () => {
    const s = await Sealer.create(key32());
    const secret = newSecret();
    const sealed = await s.seal(secret, "beacon:1:0xab");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain(bytesToHex(secret).slice(2));
    expect(bytesToHex(await s.open(sealed, "beacon:1:0xab"))).toBe(bytesToHex(secret));
  });

  test("same secret sealed twice gives different ciphertexts (random IV)", async () => {
    const s = await Sealer.create(key32());
    const secret = newSecret();
    expect(await s.seal(secret, "a")).not.toBe(await s.seal(secret, "a"));
  });

  test("wrong key, wrong job binding (aad) or a flipped byte all fail to open", async () => {
    const s = await Sealer.create(key32());
    const sealed = await s.seal(newSecret(), "beacon:1:0xab");
    await expect((await Sealer.create(key32())).open(sealed, "beacon:1:0xab")).rejects.toThrow();
    await expect(s.open(sealed, "beacon:1:0xcd")).rejects.toThrow();
    const [v, iv, ct] = sealed.split(".");
    const raw = Buffer.from(ct!, "base64");
    raw[0] = raw[0]! ^ 1;
    await expect(s.open(`${v}.${iv}.${raw.toString("base64")}`, "beacon:1:0xab")).rejects.toThrow();
    await expect(s.open("v0.x.y", "a")).rejects.toThrow(/format/);
  });

  test("KEEPER_SECRET_KEY must be 32 bytes (hex or base64); missing is an error", () => {
    const k = key32();
    expect(parseSecretKey(bytesToHex(k))).toEqual(k);
    expect(parseSecretKey(Buffer.from(k).toString("base64"))).toEqual(k);
    expect(() => parseSecretKey(undefined)).toThrow(/not set/);
    expect(() => parseSecretKey("0x1234")).toThrow(/32 bytes/);
  });

  test("newSecret: 32 bytes from the CSPRNG, never repeating", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = newSecret();
      expect(s.length).toBe(32);
      seen.add(bytesToHex(s));
    }
    expect(seen.size).toBe(200);
  });
});

describe("signing key", () => {
  test("KEEPER_PRIVATE_KEY (with or without 0x) gives the matching account", () => {
    expect(loadSigner({ KEEPER_PRIVATE_KEY: ANVIL_KEY_1 }).address).toBe(ANVIL_ADDR_1);
    expect(loadSigner({ KEEPER_PRIVATE_KEY: ANVIL_KEY_1.slice(2) }).address).toBe(ANVIL_ADDR_1);
  });

  test("no source, both sources, or a malformed key are refused, and errors never echo the key", () => {
    expect(() => loadSigner({})).toThrow(/no keeper key/);
    expect(() => loadSigner({ KEEPER_PRIVATE_KEY: ANVIL_KEY_1, KEEPER_KEYSTORE: "/x" })).toThrow(/not both/);
    expect(() => loadSigner({ KEEPER_KEYSTORE: "/x" })).toThrow(/PASSWORD_FILE/);
    const bad = `${ANVIL_KEY_1.slice(0, 40)}zz`;
    try {
      loadSigner({ KEEPER_PRIVATE_KEY: bad });
      throw new Error("expected a throw");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(bad.slice(2, 30));
    }
  });

  test.skipIf(!hasBinary("cast"))("Foundry keystore (cast wallet import) decrypts to the same account; wrong password fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-ks-"));
    const r = Bun.spawnSync(["cast", "wallet", "import", "keeper", "--private-key", ANVIL_KEY_1, "--unsafe-password", "pw-test", "--keystore-dir", dir], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const file = join(dir, readdirSync(dir)[0]!);
    const pwFile = join(dir, "pw.txt");
    writeFileSync(pwFile, "pw-test\n");
    expect(loadSigner({ KEEPER_KEYSTORE: file, KEEPER_KEYSTORE_PASSWORD_FILE: pwFile }).address).toBe(ANVIL_ADDR_1);
    expect(() => decryptKeystore(readFileSync(file, "utf8"), "nope")).toThrow(/wrong password/);
  });
});
