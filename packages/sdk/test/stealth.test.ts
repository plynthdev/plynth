import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  addressOfPrivateKey,
  checkStealthAddress,
  claimDomain,
  claimTypes,
  computeStealthAddress,
  decodeAnnouncementLog,
  decodeMetadata,
  encodeMetadata,
  generateKeys,
  KEY_DERIVATION_MESSAGE,
  keysFromPrivate,
  metaAddress,
  metaAddressBytes,
  parseMetaAddress,
  registerTx,
  registryAbi,
  scan,
  signClaim,
  stealthPrivateKey,
  ERC6538_REGISTRY,
  type Announcement,
} from "../src/stealth";

const k = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

// ERC-5564 reference notebook (ethereum/ERCs assets/erc-5564/minimal_poc.ipynb):
// ephemeral key 0xd952…6a30, viewing key 2, spending key 3.
const VEC = {
  ephemeralPrivateKey: "0xd952fe0740d9d14011fc8ead3ab7de3c739d3aa93ce9254c10b0134d80d26a30" as Hex, // test-key (ERC-5564 reference vector)
  viewingPrivateKey: k(2n),
  spendingPrivateKey: k(3n),
  stealthAddress: "0xfEd69Df0a27F1daE0D7430EAd82aaEdfAD6332bb" as Address,
  viewTag: 86,
  stealthPrivateKeyDec: 39153944482575822531387237249775711740128993925789544779866399859639729033274n,
  ephemeralPub: [
    22246744184454969143801186698733154500632648736073949898323976612504587645286n,
    110772761940586493986212935445517909380300793379795289150161960681985511655321n,
  ],
};

describe("ERC-5564 reference vectors", () => {
  const keys = keysFromPrivate(VEC.spendingPrivateKey, VEC.viewingPrivateKey);
  const meta = metaAddress(keys);

  test("computeStealthAddress reproduces the reference stealth address and view tag", () => {
    const g = computeStealthAddress(meta, VEC.ephemeralPrivateKey);
    expect(g.stealthAddress).toBe(VEC.stealthAddress);
    expect(Number(BigInt(g.viewTag))).toBe(VEC.viewTag);
    const P = secp256k1.ProjectivePoint.fromHex(g.ephemeralPublicKey.slice(2));
    expect([P.x, P.y]).toEqual(VEC.ephemeralPub);
  });

  test("checkStealthAddress recognises the reference announcement", () => {
    const g = computeStealthAddress(meta, VEC.ephemeralPrivateKey);
    expect(checkStealthAddress({ stealthAddress: VEC.stealthAddress, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: VEC.viewTag, viewingPrivateKey: keys.viewingPrivateKey, spendingPublicKey: keys.spendingPublicKey })).toBe(true);
  });

  test("stealthPrivateKey equals p_spend + h(Q) from the notebook and controls the address", () => {
    const g = computeStealthAddress(meta, VEC.ephemeralPrivateKey);
    const key = stealthPrivateKey({ ephemeralPublicKey: g.ephemeralPublicKey, viewingPrivateKey: keys.viewingPrivateKey, spendingPrivateKey: keys.spendingPrivateKey, stealthAddress: VEC.stealthAddress });
    expect(BigInt(key)).toBe(VEC.stealthPrivateKeyDec);
    expect(privateKeyToAccount(key).address).toBe(VEC.stealthAddress);
  });
});

describe("keys and meta-address", () => {
  test("generateKeys is deterministic: keccak256(r) / keccak256(s) of the signature", async () => {
    const wallet = privateKeyToAccount(k(0xc0ffeen)); // test-key
    const sig = await wallet.signMessage({ message: KEY_DERIVATION_MESSAGE });
    const a = generateKeys(sig);
    const b = generateKeys(await wallet.signMessage({ message: KEY_DERIVATION_MESSAGE }));
    expect(a).toEqual(b);
    expect(BigInt(a.spendingPrivateKey)).toBe(BigInt(keccak256(`0x${sig.slice(2, 66)}`)) % secp256k1.CURVE.n);
    expect(BigInt(a.viewingPrivateKey)).toBe(BigInt(keccak256(`0x${sig.slice(66, 130)}`)) % secp256k1.CURVE.n);
    expect(a.spendingPrivateKey).not.toBe(a.viewingPrivateKey);
    expect(() => generateKeys("0x1234")).toThrow();
  });

  test("metaAddress is st:eth:0x + two compressed keys and round-trips", () => {
    const keys = keysFromPrivate(k(3n), k(2n));
    const meta = metaAddress(keys);
    expect(meta.startsWith("st:eth:0x")).toBe(true);
    expect(meta.length).toBe("st:eth:0x".length + 132);
    expect(parseMetaAddress(meta)).toEqual({ spendingPublicKey: keys.spendingPublicKey, viewingPublicKey: keys.viewingPublicKey });
    expect(parseMetaAddress(metaAddressBytes(keys))).toEqual(parseMetaAddress(meta));
    expect(() => parseMetaAddress(`st:eth:0x${"02".padEnd(132, "f")}`)).toThrow();
    expect(() => parseMetaAddress("st:eth:0x1234")).toThrow();
  });

  test("registerTx is ERC-6538 registerKeys(1, 66-byte meta)", () => {
    const keys = keysFromPrivate(k(3n), k(2n));
    const tx = registerTx(metaAddress(keys));
    expect(tx.to).toBe(ERC6538_REGISTRY);
    expect(tx.data.slice(0, 10)).toBe("0x042c7aa3");
    const d = decodeFunctionData({ abi: registryAbi, data: tx.data });
    expect(d.args).toEqual([1n, metaAddressBytes(keys)]);
  });
});

describe("random round trips", () => {
  test("fresh ephemeral key per call; recipient finds and controls every address", () => {
    for (let i = 0; i < 25; i++) {
      const keys = keysFromPrivate(bytesToHex(secp256k1.utils.randomPrivateKey()), bytesToHex(secp256k1.utils.randomPrivateKey()));
      const meta = metaAddress(keys);
      const a = computeStealthAddress(meta);
      const b = computeStealthAddress(meta);
      expect(a.stealthAddress).not.toBe(b.stealthAddress);
      expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
      const key = stealthPrivateKey({ ephemeralPublicKey: a.ephemeralPublicKey, viewingPrivateKey: keys.viewingPrivateKey, spendingPrivateKey: keys.spendingPrivateKey, stealthAddress: a.stealthAddress });
      expect(addressOfPrivateKey(key)).toBe(a.stealthAddress);
    }
  });

  test("someone else's keys do not match, and wrong keys cannot derive the private key", () => {
    const mine = keysFromPrivate(k(11n), k(12n));
    const other = keysFromPrivate(k(13n), k(14n));
    const g = computeStealthAddress(metaAddress(mine));
    expect(checkStealthAddress({ ...g, viewingPrivateKey: other.viewingPrivateKey, spendingPublicKey: other.spendingPublicKey })).toBe(false);
    // right viewing key, wrong view tag: short-circuits to false
    const wrongTag = (Number(BigInt(g.viewTag)) + 1) % 256;
    expect(checkStealthAddress({ ...g, viewTag: wrongTag, viewingPrivateKey: mine.viewingPrivateKey, spendingPublicKey: mine.spendingPublicKey })).toBe(false);
    expect(() => stealthPrivateKey({ ephemeralPublicKey: g.ephemeralPublicKey, viewingPrivateKey: mine.viewingPrivateKey, spendingPrivateKey: other.spendingPrivateKey, stealthAddress: g.stealthAddress })).toThrow();
  });
});

describe("metadata and scan", () => {
  const token = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;

  test("metadata is viewTag | transfer selector | token | amount (57 bytes)", () => {
    const m = encodeMetadata("0x56", token, 123n);
    expect((m.length - 2) / 2).toBe(57);
    expect(decodeMetadata(m)).toEqual({ viewTag: 0x56, selector: "0xa9059cbb", token, amount: 123n });
    expect(decodeMetadata("0x56")).toEqual({ viewTag: 0x56 });
  });

  test("scan finds only the viewer's announcements among noise, with token and amount", () => {
    const mine = keysFromPrivate(k(101n), k(102n));
    const other = keysFromPrivate(k(201n), k(202n));
    const crowd = "0x00000000000000000000000000000000000c0d00" as Address;
    const anns: Announcement[] = [];
    const want: Address[] = [];
    for (let i = 0; i < 40; i++) {
      const isMine = i % 7 === 3;
      const g = computeStealthAddress(metaAddress(isMine ? mine : other));
      if (isMine) want.push(g.stealthAddress);
      anns.push({ schemeId: 1n, stealthAddress: g.stealthAddress, caller: crowd, ephemeralPublicKey: g.ephemeralPublicKey, metadata: encodeMetadata(g.viewTag, token, BigInt(i)) });
    }
    // garbage and other schemes are skipped, not thrown on
    anns.push({ schemeId: 1n, stealthAddress: want[0]!, caller: crowd, ephemeralPublicKey: "0x02ff", metadata: "0x00" });
    anns.push({ ...anns[3]!, schemeId: 2n });
    anns.push({ ...anns[3]!, metadata: "0x" });
    const hits = scan(anns, mine.viewingPrivateKey, mine.spendingPublicKey);
    expect(hits.map((h) => h.stealthAddress)).toEqual(want);
    expect(hits.every((h) => h.token === token)).toBe(true);
    expect(hits.map((h) => h.amount)).toEqual([3n, 10n, 17n, 24n, 31n, 38n]);
    expect(scan(anns, mine.viewingPrivateKey, mine.spendingPublicKey, { callers: ["0x0000000000000000000000000000000000000001"] })).toEqual([]);
  });

  test("decodeAnnouncementLog reads the announcer's log layout", () => {
    const stealth = "0x1111111111111111111111111111111111111111" as Address;
    const caller = "0x2222222222222222222222222222222222222222" as Address;
    const epk = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" as Hex; // not-a-key (generator point)
    const md = encodeMetadata("0x01", token, 5n);
    const a = decodeAnnouncementLog({
      topics: ["0x00", toHex(1n, { size: 32 }), `0x${stealth.slice(2).padStart(64, "0")}`, `0x${caller.slice(2).padStart(64, "0")}`],
      data: encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [epk, md]),
    });
    expect(a).toMatchObject({ schemeId: 1n, stealthAddress: getAddress(stealth), caller: getAddress(caller), ephemeralPublicKey: epk, metadata: md });
  });
});

describe("claim signing", () => {
  test("signClaim produces an EIP-712 signature that recovers to the stealth address", async () => {
    const stealthKey = k(0x5eedn); // test-key
    const sc = "0x3333333333333333333333333333333333333333" as Address;
    const { message, sig } = await signClaim(stealthKey, 31337, sc, { token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", to: "0x4444444444444444444444444444444444444444", raw: 10n, nonce: 0n, deadline: 99n });
    expect(message.stealth).toBe(addressOfPrivateKey(stealthKey));
    const signer = await recoverTypedDataAddress({ domain: claimDomain(31337, sc), types: claimTypes, primaryType: "Claim", message, signature: sig });
    expect(signer).toBe(message.stealth);
  });
});
