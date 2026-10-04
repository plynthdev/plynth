// Todo 30: the hourly receipt tree (pure). Same tree as Receipts.t.sol and OpenZeppelin MerkleProof.
import { describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { hashPair, hourOf, leafOf, leafOfRow, merkleProof, merkleRoot, rowJson, verifyProof, ZERO_ROOT, type ActionRow } from "../receipts/tree";

const row = (id: number, over: Partial<ActionRow> = {}): ActionRow => ({
  id,
  chainId: 31337,
  account: "0x00000000000000000000000000000000000000aa",
  desk: "equity",
  action: "buy",
  status: id % 3 === 0 ? "rejected" : "sent",
  reasonCode: id % 3 === 0 ? 4 : null,
  reason: id % 3 === 0 ? "R3_ORDER_CAP" : null,
  adapter: null,
  asset: "0x00000000000000000000000000000000000000bb",
  amount: String(id * 1000),
  notionalUsd: null,
  beaconKey: null,
  txHash: null,
  blockNumber: BigInt(100 + id),
  detail: { b: 1, a: [id, "x"] },
  createdAt: new Date(Date.UTC(2026, 9, 4, 10, id % 60)),
  ...over,
});

describe("receipt tree", () => {
  test("an empty hour has the zero root; one leaf is its own root", () => {
    expect(merkleRoot([])).toBe(ZERO_ROOT);
    const l = leafOfRow(row(1));
    expect(merkleRoot([l])).toBe(l);
    expect(merkleProof([l], 0)).toEqual([]);
    expect(verifyProof([], l, l)).toBe(true);
  });

  test("every leaf of every tree size 1..40 verifies, and no foreign leaf does", () => {
    for (let n = 1; n <= 40; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafOfRow(row(i + 1)));
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) expect(verifyProof(merkleProof(leaves, i), root, leaves[i]!)).toBe(true);
      const foreign = leafOfRow(row(999));
      expect(verifyProof(merkleProof(leaves, 0), root, foreign)).toBe(false);
    }
    expect(() => merkleProof([ZERO_ROOT], 1)).toThrow();
  });

  test("pairs hash in sorted order (OpenZeppelin commutative keccak)", () => {
    const a = keccak256(toHex("a"));
    const b = keccak256(toHex("b"));
    expect(hashPair(a, b)).toBe(hashPair(b, a));
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    expect(hashPair(a, b)).toBe(keccak256(`${lo}${hi.slice(2)}` as Hex));
  });

  test("a leaf commits to every column: changing any field (status, reason, time, detail) changes it", () => {
    const base = leafOfRow(row(3));
    expect(leafOfRow(row(3, { status: "sent" }))).not.toBe(base);
    expect(leafOfRow(row(3, { reasonCode: null }))).not.toBe(base);
    expect(leafOfRow(row(3, { createdAt: new Date(Date.UTC(2026, 9, 4, 10, 4)) }))).not.toBe(base);
    expect(leafOfRow(row(3, { detail: { b: 2, a: [3, "x"] } }))).not.toBe(base);
    expect(leafOfRow(row(3, { blockNumber: null }))).not.toBe(base);
  });

  test("row JSON is canonical: key order of the row and of detail does not matter; nulls are kept", () => {
    const r = row(5);
    const shuffled = Object.fromEntries(Object.entries(r).reverse()) as ActionRow;
    expect(rowJson({ ...shuffled, detail: { a: [5, "x"], b: 1 } })).toBe(rowJson(r));
    expect(rowJson(r)).toContain('"reasonCode":null');
    expect(rowJson(r)).toContain('"blockNumber":"105"');
  });

  test("leaf = keccak256(abi.encode(rowHash)) (Receipts.leafOf), never the row hash itself", () => {
    const h = keccak256(toHex(rowJson(row(1))));
    expect(leafOfRow(row(1))).toBe(leafOf(h));
    expect(leafOf(h)).toBe(keccak256(h));
    expect(leafOf(h)).not.toBe(h);
  });

  test("hours are UTC epoch hours", () => {
    expect(hourOf(new Date(3600_000 * 5 + 3599_999))).toBe(5n);
    expect(hourOf(new Date(3600_000 * 6))).toBe(6n);
  });
});
