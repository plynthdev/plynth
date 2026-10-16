// Audit M-6: SavingsVault.setHiddenKeys and the ERC-6538 registry store any bytes. Keys that can never receive a
// note or a stealth payment are refused by the SDK before they are registered (and by the keeper before planning).
import { beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { generateKeys, metaAddressBytes, parseMetaAddress, registerTx } from "../src/stealth";
import { assertHiddenKeys, deriveVaultKeys, hiddenKeysProblem, initVault, P, registration, setHiddenKeysTx } from "../src/vault";

const VAULT = "0x00000000000000000000000000000000000000c2";
// libsodium's x25519 low-order blocklist: canonical and non-canonical encodings.
const LOW_ORDER: Hex[] = [
  `0x${"00".repeat(32)}`,
  `0x01${"00".repeat(31)}`,
  "0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", // not-a-key
  "0x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", // not-a-key
  `0xec${"ff".repeat(30)}7f`,
  `0xed${"ff".repeat(30)}7f`,
  `0xee${"ff".repeat(30)}7f`,
];
// Bit 255 set or u >= p: RFC 7748 decodes these as another key than the bytes say.
const NON_CANONICAL: Hex[] = [
  "0xcdeb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880", // not-a-key
  "0x4c9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7", // not-a-key
  `0xd9${"ff".repeat(31)}`,
  `0xef${"ff".repeat(30)}7f`,
];

beforeAll(async () => {
  await initVault();
});

describe("Hidden keys", () => {
  test("derived keys are valid; registration and setHiddenKeysTx encode them", () => {
    const k = deriveVaultKeys(`0x${"77".repeat(65)}` as Hex);
    expect(hiddenKeysProblem(k.ownerPk, k.viewingPub)).toBeNull();
    const reg = registration(k);
    const d = decodeFunctionData({ abi: parseAbi(["function setHiddenKeys(bytes32 ownerPk, bytes32 viewingPub)"]), data: setHiddenKeysTx(VAULT, reg).data });
    expect(d.args).toEqual([reg.ownerPk, reg.viewingPub]);
  });

  test("every low-order viewing key is refused", () => {
    const k = deriveVaultKeys(`0x${"77".repeat(65)}` as Hex);
    for (const v of LOW_ORDER) {
      expect(hiddenKeysProblem(k.ownerPk, v)).toMatch(/low-order/);
      expect(() => setHiddenKeysTx(VAULT, { ownerPk: registration(k).ownerPk, viewingPub: v })).toThrow(/low-order/);
      expect(() => registration({ ...k, viewingPub: Buffer.from(v.slice(2), "hex") })).toThrow(/low-order/);
    }
  });

  test("non-canonical viewing keys are refused", () => {
    const k = deriveVaultKeys(`0x${"77".repeat(65)}` as Hex);
    for (const v of NON_CANONICAL) expect(hiddenKeysProblem(k.ownerPk, v)).toMatch(/low-order|canonical/);
  });

  test("ownerPk must be a non-zero field element; viewingPub 32 bytes", () => {
    const k = deriveVaultKeys(`0x${"77".repeat(65)}` as Hex);
    expect(hiddenKeysProblem(0n, k.viewingPub)).toMatch(/no Hidden keys/);
    expect(hiddenKeysProblem(P, k.viewingPub)).toMatch(/field/);
    expect(hiddenKeysProblem(k.ownerPk, k.viewingPub.slice(0, 31))).toMatch(/32 bytes/);
    expect(() => assertHiddenKeys(P - 1n, k.viewingPub)).not.toThrow();
  });
});

describe("Quiet meta-address", () => {
  test("registerTx refuses a key that is not on secp256k1", () => {
    const good = metaAddressBytes(generateKeys(`0x${"ab".repeat(32)}${"cd".repeat(32)}1b` as Hex));
    expect(() => registerTx(good)).not.toThrow();
    let bad: Hex | undefined;
    for (let x = 1; !bad; x++) {
      const p = `0x02${x.toString(16).padStart(64, "0")}${good.slice(68)}` as Hex;
      try {
        parseMetaAddress(p);
      } catch {
        bad = p;
      }
    }
    expect(() => registerTx(bad!)).toThrow();
  });
});
