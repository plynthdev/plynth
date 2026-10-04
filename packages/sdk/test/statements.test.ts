// Statements + scoped disclosure without a chain: note status at a block, viewing-key-only limits, change
// detection, output formats, bundle shape checks and verifyDisclosure against an in-memory log source.
// The anvil end-to-end (real pool, real proofs, shadow ledger, valuation) is apps/api/test/statements.anvil.test.ts.
import { beforeAll, describe, expect, test } from "bun:test";
import { getAddress, type Hex, type PublicClient } from "viem";
import {
  checkBundleShape,
  discloseNotes,
  notesAt,
  rootFromPath,
  statementToCsv,
  statementToHtml,
  statementToJson,
  verifyDisclosure,
  viewingKeyOf,
  type PoolHistory,
  type Statement,
} from "../src/statements";
import { commitmentOf, deriveVaultKeys, encryptNote, initVault, NoteTree, nullifierOf, randomField, toBytes32, type VaultKeys } from "../src/vault";

const ASSET = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const POOL = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const sig = (b: string) => `0x${b.repeat(65)}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

let me: VaultKeys;
let other: VaultKeys;
beforeAll(async () => {
  await initVault();
  me = deriveVaultKeys(sig("e5"));
  other = deriveVaultKeys(sig("f6"));
});

/** A hand-built pool history: what scanPool returns from events. */
class Hist {
  h: PoolHistory = { pool: POOL, fromBlock: 1n, toBlock: 100n, leaves: [], encrypted: [], nullifiers: new Map(), deposits: new Map(), refunds: new Map() };
  roots: { root: bigint; block: bigint }[] = [];
  tree = new NoteTree();
  private li = 0;
  note(owner: VaultKeys, raw: bigint, block: bigint, opts: { deposit?: boolean; insertAt?: bigint | null; txn?: number } = {}) {
    const blinding = randomField();
    const commitment = commitmentOf(BigInt(ASSET), raw, owner.ownerPk, blinding);
    const txHash = tx(opts.txn ?? Number(block));
    this.h.encrypted.push({ commitment, data: encryptNote({ asset: ASSET, raw, blinding }, owner.viewingPub), block, logIndex: this.li++, txHash });
    if (opts.deposit) this.h.deposits.set(commitment, { pendingId: BigInt(this.h.deposits.size), origin: ASSET, raw, asset: ASSET, block, logIndex: this.li++, txHash });
    const insertAt = opts.insertAt === undefined ? block : opts.insertAt;
    if (insertAt !== null) this.insert(commitment, insertAt, opts.txn);
    return { commitment, blinding, raw };
  }
  insert(commitment: bigint, block: bigint, txn?: number) {
    const index = this.tree.insert(commitment);
    this.h.leaves.push({ index, commitment, block, logIndex: this.li++, txHash: tx(txn ?? Number(block)) });
    this.roots.push({ root: this.tree.root(), block });
    return index;
  }
  spend(owner: VaultKeys, commitment: bigint, block: bigint, txn?: number) {
    const idx = this.h.leaves.find((l) => l.commitment === commitment)!.index;
    const n = nullifierOf(commitment, owner.spendingSecret, BigInt(idx));
    this.h.nullifiers.set(n, { block, logIndex: this.li++, txHash: tx(txn ?? Number(block)) });
    return n;
  }
}

describe("notes at a block", () => {
  test("a note spent before period end shows as spent; spent after period end shows unspent", () => {
    const H = new Hist();
    const a = H.note(me, 100n, 10n, { deposit: true });
    const b = H.note(me, 50n, 12n, { deposit: true });
    H.spend(me, a.commitment, 20n);
    H.spend(me, b.commitment, 40n);
    const at30 = notesAt(H.h, me, 30n);
    expect(at30.find((n) => n.raw === 100n)).toMatchObject({ status: "spent", spentBlock: 20n });
    expect(at30.find((n) => n.raw === 50n)).toMatchObject({ status: "unspent", spentBlock: null });
    expect(notesAt(H.h, me, 40n).every((n) => n.status === "spent")).toBe(true);
    expect(notesAt(H.h, me, 11n).map((n) => n.raw)).toEqual([100n]); // b not created yet
  });

  test("viewing key alone: every note found, spent status unknown, no nullifiers", () => {
    const H = new Hist();
    const a = H.note(me, 100n, 10n);
    H.spend(me, a.commitment, 20n);
    const v = viewingKeyOf(me);
    expect(Object.keys(v).sort()).toEqual(["ownerPk", "viewingSecret"]);
    const n = notesAt(H.h, v, 30n);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ status: "unknown", nullifier: null, spentBlock: null });
  });

  test("pending, refunded, someone else's and mis-committed notes", () => {
    const H = new Hist();
    const p = H.note(me, 7n, 10n, { deposit: true, insertAt: null });
    H.note(me, 8n, 11n, { deposit: true, insertAt: null });
    H.h.refunds.set(H.h.encrypted[1]!.commitment, { block: 15n, logIndex: 99, txHash: tx(15) });
    H.note(other, 9n, 12n);
    // encrypted to me, committed to another owner: ignored
    const bl = randomField();
    H.h.encrypted.push({ commitment: commitmentOf(BigInt(ASSET), 5n, other.ownerPk, bl), data: encryptNote({ asset: ASSET, raw: 5n, blinding: bl }, me.viewingPub), block: 13n, logIndex: 50, txHash: tx(13) });
    const n = notesAt(H.h, me, 20n);
    expect(n.map((x) => [x.raw, x.status])).toEqual([
      [7n, "pending"],
      [8n, "refunded"],
    ]);
    expect(n[0]!.commitment).toBe(p.commitment);
    H.insert(p.commitment, 30n);
    expect(notesAt(H.h, me, 30n)[0]).toMatchObject({ status: "unspent", leafIndex: 1, insertedBlock: 30n });
  });

  test("an output created in the tx that spent my note is change; from others it is received", () => {
    const H = new Hist();
    const a = H.note(me, 100n, 10n, { deposit: true });
    H.spend(me, a.commitment, 20n, 777);
    H.note(me, 40n, 20n, { txn: 777 }); // change
    H.note(me, 5n, 25n); // from someone
    const n = notesAt(H.h, me, 30n);
    expect(n.map((x) => x.source)).toEqual(["deposit", "change", "received"]);
  });
});

function fakeStatement(): Statement {
  return {
    version: 1,
    kind: "plynth.statement",
    chainId: 31337,
    pool: POOL,
    ownerPk: 5n,
    period: { fromBlock: 1n, toBlock: 9n, start: 1_700_000_000n, end: 1_700_086_399n },
    spendsVisible: true,
    balances: [
      { asset: ASSET, symbol: "=cmd()<b>", decimals: 18, opening: 0n, in: 10n ** 18n, out: 0n, closing: 10n ** 18n, pending: 0n, usd18: 250n * 10n ** 18n, priceUsd18: 250n * 10n ** 18n, multiplier18: 10n ** 18n, hold: false },
    ],
    movements: [{ block: 3n, logIndex: 0, timestamp: 1_700_000_100n, txHash: tx(3), type: "in", kind: "deposit", asset: ASSET, symbol: "=cmd()<b>", raw: 10n ** 18n, commitment: 9n }],
    notes: [],
    totalUsd18: 250n * 10n ** 18n,
    generatedAt: "2026-10-04T00:00:00.000Z",
  };
}

describe("formats", () => {
  test("JSON is bigint-free and has no blinding", () => {
    const j = statementToJson(fakeStatement());
    const s = JSON.stringify(j);
    expect(s).not.toContain("blinding");
    expect((j as any).balances[0].closingUnits).toBe("1");
    expect((j as any).totalUsd).toBe("250");
  });

  test("CSV: balances + movements, formula cells neutralised", () => {
    const csv = statementToCsv(fakeStatement());
    expect(csv.split("\n")[0]).toStartWith("section,asset,symbol,opening");
    expect(csv).toContain("'=cmd()<b>");
    expect(csv).toContain("movement,2023-11-14T22:15:00.000Z,3,in,deposit");
  });

  test("HTML: self-contained (no scripts or external loads), escaped", () => {
    const html = statementToHtml(fakeStatement());
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("Viewing-key statement");
    expect(html).toContain("$250.00");
    expect(html).not.toMatch(/<script|src=|href=|@import|url\(/i);
    expect(html).toContain("=cmd()&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

/** In-memory PublicClient slice for verifyDisclosure: RootUpdated and NullifierSpent logs. */
function fakePub(H: Hist, head = 100n, chainId = 31337): PublicClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => head,
    getLogs: async (q: any) => {
      const inRange = (b: bigint) => b >= q.fromBlock && b <= q.toBlock;
      if (q.event.name === "RootUpdated")
        return H.roots.filter((r) => inRange(r.block)).map((r, i) => ({ blockNumber: r.block, logIndex: i, transactionHash: tx(1), args: { root: toBytes32(r.root) } }));
      if (q.event.name === "NullifierSpent")
        return [...H.h.nullifiers]
          .filter(([n, p]) => inRange(p.block) && toBytes32(n) === q.args.nullifier)
          .map(([n, p]) => ({ blockNumber: p.block, logIndex: p.logIndex, transactionHash: p.txHash, args: { nullifier: toBytes32(n) } }));
      throw new Error(`unexpected getLogs ${q.event.name}`);
    },
  } as unknown as PublicClient;
}

describe("scoped disclosure", () => {
  function setup() {
    const H = new Hist();
    H.note(other, 1n, 5n);
    H.note(me, 100n, 10n, { deposit: true });
    H.note(me, 60n, 15n, { deposit: true });
    H.note(me, 30n, 18n, { deposit: true });
    H.spend(me, H.h.leaves[2]!.commitment, 25n); // 60 spent inside the period
    H.spend(me, H.h.leaves[3]!.commitment, 60n); // 30 spent after the period
    H.note(other, 2n, 45n); // a later root outside the period
    return H;
  }
  const period = { fromBlock: 10n, toBlock: 40n };

  test("bundle verifies; spent/unspent/spent-after per disclosed nullifier; totals exclude spent", async () => {
    const H = setup();
    const mine = notesAt(H.h, me, 40n);
    const b = discloseNotes(mine, period, { chainId: 31337, pool: POOL, history: H.h });
    expect(JSON.stringify(b)).not.toMatch(/viewing|spending|secret/i);
    expect(b.root).toBe(toBytes32(H.roots[3]!.root)); // the root in force at block 40, not the later one
    const v = await verifyDisclosure(fakePub(H), b, { pool: POOL });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.rootBlock).toBe("18");
    expect(v.notes.map((n) => n.nullifierStatus)).toEqual(["unspent", "spent", "spent-after-period"]);
    expect(v.totals).toEqual([{ asset: ASSET, raw: "130" }]);
  });

  test("tampered bundles fail: amount +1, other blinding, wrong leaf, wrong root, wrong chain/pool, duplicate", async () => {
    const H = setup();
    const b = discloseNotes(notesAt(H.h, me, 40n).slice(0, 1), period, { chainId: 31337, pool: POOL, history: H.h });
    const clone = () => JSON.parse(JSON.stringify(b));
    const t1 = clone();
    t1.notes[0].raw = String(BigInt(t1.notes[0].raw) + 1n);
    let v = await verifyDisclosure(fakePub(H), t1);
    expect(v.ok).toBe(false);
    expect(v.notes[0]!.error).toMatch(/not in the pool's tree/);
    const t2 = clone();
    t2.notes[0].blinding = toBytes32(randomField());
    expect((await verifyDisclosure(fakePub(H), t2)).ok).toBe(false);
    const t3 = clone();
    t3.notes[0].leafIndex = 2;
    expect((await verifyDisclosure(fakePub(H), t3)).ok).toBe(false);
    const t4 = clone();
    t4.root = toBytes32(H.roots[4]!.root); // a real root, but not the one at period end
    v = await verifyDisclosure(fakePub(H), t4);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/root at period end/);
    expect((await verifyDisclosure(fakePub(H, 100n, 1), b)).errors.join()).toMatch(/chain/);
    expect((await verifyDisclosure(fakePub(H), b, { pool: ASSET })).errors.join()).toMatch(/different pool/);
    const t5 = clone();
    t5.notes.push(t5.notes[0]);
    v = await verifyDisclosure(fakePub(H), t5);
    expect(v.ok).toBe(false);
    expect(v.notes[1]!.error).toMatch(/twice/);
    expect((await verifyDisclosure(fakePub(H, 30n), b)).errors.join()).toMatch(/after the chain head/);
  });

  test("discloseNotes refuses notes not in the tree by period end; path helper matches the tree", () => {
    const H = setup();
    const late = notesAt(H.h, other, 100n).find((n) => n.raw === 2n)!;
    expect(() => discloseNotes([late], period, { chainId: 31337, pool: POOL, history: H.h })).toThrow(/not in the tree/);
    expect(() => discloseNotes([], period, { chainId: 31337, pool: POOL, history: H.h })).toThrow();
    expect(rootFromPath(H.h.leaves[1]!.commitment, 1, H.tree.path(1))).toBe(H.tree.root());
  });

  test("shape checks reject junk without touching the chain", async () => {
    expect(checkBundleShape(null)).not.toEqual([]);
    expect(checkBundleShape({ version: 1, kind: "plynth.disclosure", chainId: 1, pool: POOL, period: { fromBlock: "5", toBlock: "4" }, root: toBytes32(1n), notes: [{}] }).join()).toMatch(/period/);
    const H = setup();
    const b = discloseNotes(notesAt(H.h, me, 40n).slice(0, 1), period, { chainId: 31337, pool: POOL, history: H.h }) as any;
    const bad = { ...b, notes: [{ ...b.notes[0], path: b.notes[0].path.slice(1) }] };
    const v = await verifyDisclosure(fakePub(H), bad);
    expect(v.notes[0]!.error).toMatch(/path/);
    const noNull = { ...b, notes: [{ ...b.notes[0], nullifier: undefined }] };
    expect((await verifyDisclosure(fakePub(H), noNull)).notes[0]!.nullifierStatus).toBe("not-disclosed");
  });
});

