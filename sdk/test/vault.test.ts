// Hidden Vault SDK: note model == Noir/Solidity, keys, ECIES notes, local tree, wallet scan, proofs, tx builders.
import { UltraHonkBackend, Barretenberg } from "@aztec/bb.js";
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, getAddress, hexToBytes, type Hex } from "viem";
import circuitConstants from "../../circuits/constants.json" with { type: "json" };
import { CIRCUITS, compactArtifact } from "../scripts/sync-circuits";
import {
  ENCRYPTED_NOTE_BYTES,
  NoteTree,
  P,
  TREE_DEPTH,
  VAULT_KEY_MESSAGE,
  ZERO_LEAF,
  balances,
  commitmentOf,
  decryptNote,
  depositTx,
  deriveVaultKeys,
  destroyProver,
  emptyState,
  encodeTwoNotes,
  extHashOf,
  withdrawExtData,
  encryptNote,
  hash,
  initVault,
  myNotes,
  nullifierOf,
  ownerPkOf,
  proveTransfer,
  proveWithdraw,
  randomField,
  registration,
  shieldedPoolAbi,
  submitWithdraw,
  toBytes32,
  transferTx,
  withdrawRequest,
  withdrawTx,
  zeroHashes,
  type OwnedNote,
  type PoolState,
} from "../src/vault";

const ROOT = join(import.meta.dir, "..", "..");
const ASSET = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const RELAYER = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const sig = (b: string) => `0x${b.repeat(65)}` as Hex;

beforeAll(async () => {
  await initVault();
});
afterAll(async () => {
  await destroyProver();
});

describe("note model matches the circuits and the contract", () => {
  test("constants equal circuits/constants.json", () => {
    expect(TREE_DEPTH).toBe(circuitConstants.treeDepth);
    expect(ZERO_LEAF).toBe(BigInt(circuitConstants.zeroLeaf));
  });

  test("sponge equals Noir on the 100 fixture inputs per arity, and zero subtrees match", () => {
    const fx = JSON.parse(readFileSync(join(ROOT, "contracts/test/consumer/verifiers/fixtures/poseidon2.json"), "utf8"));
    const n = (k: string, i: number) => BigInt(fx[k][i]);
    for (let i = 0; i < 100; i++) {
      expect(hash([n("a", i)])).toBe(n("h1", i));
      expect(hash([n("a", i), n("b", i)])).toBe(n("h2", i));
      expect(hash([n("a", i), n("b", i), n("c", i)])).toBe(n("h3", i));
      expect(hash([n("a", i), n("b", i), n("c", i), n("d", i)])).toBe(n("h4", i));
    }
    expect(zeroHashes().map(String)).toEqual(fx.zeros);
  });

  test("Noir stdlib known digest", () => {
    expect(hash([1n, 2n, 3n, 4n, 5n])).toBe(0x2247be7014a54d17342a7ef677f58d28877780d203860396967f5d0a18d259dbn); // not-a-key
  });

  test("shipped circuit artifacts equal the compiled circuits (when built)", () => {
    for (const c of CIRCUITS) {
      if (!existsSync(join(ROOT, "circuits", c, "target", `${c}.json`))) {
        console.warn(`skip: circuits/${c}/target not built (bash circuits/scripts/build.sh)`);
        continue;
      }
      expect(readFileSync(join(import.meta.dir, "..", "src", "vault", "artifacts", `${c}.json`), "utf8")).toBe(compactArtifact(c));
    }
  });
});

describe("keys from a wallet signature", () => {
  test("deterministic, distinct per signature, ownerPk = Poseidon2(spendingSecret)", () => {
    const a = deriveVaultKeys(sig("a1"));
    const a2 = deriveVaultKeys(sig("a1"));
    const b = deriveVaultKeys(sig("b0"));
    expect(a.spendingSecret).toBe(a2.spendingSecret);
    expect(a.viewingPub).toEqual(a2.viewingPub);
    expect(a.spendingSecret).not.toBe(b.spendingSecret);
    expect(a.spendingSecret < P && a.spendingSecret > 0n).toBe(true);
    expect(a.ownerPk).toBe(ownerPkOf(a.spendingSecret));
    expect(a.viewingPub.length).toBe(32);
    const r = registration(a);
    expect(BigInt(r.ownerPk)).toBe(a.ownerPk);
    expect(hexToBytes(r.viewingPub)).toEqual(a.viewingPub);
    expect(VAULT_KEY_MESSAGE).toContain("Hidden Vault");
  });

  test("rejects anything but a 65-byte signature", () => {
    expect(() => deriveVaultKeys("0x1234")).toThrow();
    expect(() => deriveVaultKeys(sig("a1").slice(0, -2) as Hex)).toThrow();
  });
});

describe("encrypted notes (x25519 + XChaCha20-Poly1305)", () => {
  const k = () => deriveVaultKeys(sig("c3"));

  test("round trip; 141 bytes, within the pool's 512", () => {
    const note = { asset: ASSET, raw: (1n << 128n) - 1n, blinding: P - 1n };
    const enc = encryptNote(note, k().viewingPub);
    expect(hexToBytes(enc).length).toBe(ENCRYPTED_NOTE_BYTES);
    expect(ENCRYPTED_NOTE_BYTES).toBeLessThanOrEqual(512);
    expect(decryptNote(enc, k().viewingSecret)).toEqual(note);
  });

  test("another viewing key, a flipped byte or garbage -> null", () => {
    const enc = encryptNote({ asset: ASSET, raw: 5n, blinding: 7n }, k().viewingPub);
    expect(decryptNote(enc, deriveVaultKeys(sig("d4")).viewingSecret)).toBeNull();
    const b = hexToBytes(enc);
    b[100] = b[100]! ^ 1;
    expect(decryptNote(`0x${Buffer.from(b).toString("hex")}`, k().viewingSecret)).toBeNull();
    expect(decryptNote("0x", k().viewingSecret)).toBeNull();
    expect(decryptNote("0xzz" as Hex, k().viewingSecret)).toBeNull();
  });

  test("fresh ephemeral key and nonce per note (same note encrypts differently)", () => {
    const n = { asset: ASSET, raw: 5n, blinding: 7n };
    expect(encryptNote(n, k().viewingPub)).not.toBe(encryptNote(n, k().viewingPub));
  });
});

describe("local tree", () => {
  test("root and paths match a from-scratch rebuild for every size up to 9", () => {
    const zeros = zeroHashes();
    const t = new NoteTree();
    expect(t.root()).toBe(zeros[TREE_DEPTH]!);
    const leaves: bigint[] = [];
    for (let i = 0; i < 9; i++) {
      leaves.push(randomField());
      t.insert(leaves[i]!);
      // reference: level by level
      let level = leaves.slice();
      for (let d = 0; d < TREE_DEPTH; d++) {
        const next: bigint[] = [];
        for (let j = 0; j < level.length; j += 2) next.push(hash([level[j]!, level[j + 1] ?? zeros[d]!]));
        level = next;
      }
      expect(t.root()).toBe(level[0]!);
      for (let j = 0; j <= i; j++) {
        let node = leaves[j]!;
        const path = t.path(j);
        for (let d = 0; d < TREE_DEPTH; d++) node = (j >> d) & 1 ? hash([path[d]!, node]) : hash([node, path[d]!]);
        expect(node).toBe(t.root());
      }
    }
  });
});

describe("local tree rollover (S8: a full tree starts the next one; leaf indexes stay global)", () => {
  test("each tree has its own root and positions; paths open to their own tree's root", () => {
    const t = new NoteTree(4); // the pool's capacity is 2^20; 4 makes rollover testable
    const ref = new NoteTree();
    const leaves = Array.from({ length: 6 }, () => randomField());
    for (const l of leaves) t.insert(l);
    for (const l of leaves.slice(0, 4)) ref.insert(l);
    expect(t.size).toBe(6);
    expect(t.rootOf(3)).toBe(ref.root()); // tree 0, full: its final root
    expect(t.treeOf(5)).toBe(1);
    expect(t.position(5)).toBe(1);
    const second = new NoteTree();
    second.insert(leaves[4]!);
    second.insert(leaves[5]!);
    expect(t.root()).toBe(second.root()); // new leaves go into tree 1
    expect(t.rootOf(5)).toBe(second.root());
    expect(t.path(5)).toEqual(second.path(1));
    expect(t.leaf(5)).toBe(leaves[5]);
  });
});

/** A synced pool state built by hand: what syncPool produces from events. */
function stateWith(entries: { commitment: bigint; data: Hex; inserted: boolean }[], spent: bigint[] = []): PoolState {
  const s = emptyState();
  for (const e of entries) {
    s.encrypted.push({ commitment: e.commitment, data: e.data });
    if (e.inserted) s.leafOf.set(e.commitment, s.tree.insert(e.commitment));
  }
  for (const n of spent) s.spent.add(n);
  return s;
}

describe("wallet scan", () => {
  test("finds own notes only, with leaf index, nullifier, spent and pending flags", () => {
    const me = deriveVaultKeys(sig("e5"));
    const other = deriveVaultKeys(sig("f6"));
    const mk = (owner: typeof me, raw: bigint) => {
      const blinding = randomField();
      return { commitment: commitmentOf(BigInt(ASSET), raw, owner.ownerPk, blinding), data: encryptNote({ asset: ASSET, raw, blinding }, owner.viewingPub) };
    };
    const a = mk(me, 100n);
    const b = mk(other, 200n);
    const c = mk(me, 300n);
    const d = mk(me, 400n); // pending
    // e: encrypted to me but committed to someone else's ownerPk (a lying keeper / sender): ignored
    const eb = randomField();
    const e = { commitment: commitmentOf(BigInt(ASSET), 999n, other.ownerPk, eb), data: encryptNote({ asset: ASSET, raw: 999n, blinding: eb }, me.viewingPub) };
    const nA = nullifierOf(a.commitment, me.spendingSecret, 0n);
    const s = stateWith([{ ...a, inserted: true }, { ...b, inserted: true }, { ...c, inserted: true }, { ...d, inserted: false }, { ...e, inserted: true }], [nA]);
    const notes = myNotes(s, me);
    expect(notes.map((n) => n.raw)).toEqual([100n, 300n, 400n]);
    expect(notes[0]!).toMatchObject({ leafIndex: 0, nullifier: nA, spent: true });
    expect(notes[1]!).toMatchObject({ leafIndex: 2, spent: false });
    expect(notes[2]!).toMatchObject({ leafIndex: null, nullifier: null, spent: false });
    expect(balances(notes).get(ASSET)).toBe(300n);
    expect(myNotes(s, other).map((n) => n.raw)).toEqual([200n]);
  });
});

describe("proofs (noir_js + bb.js) and tx builders", () => {
  const alice = () => deriveVaultKeys(sig("a1"));
  const bob = () => deriveVaultKeys(sig("b0"));

  function seeded(raws: bigint[]): { tree: NoteTree; notes: OwnedNote[] } {
    const tree = new NoteTree();
    tree.insert(123n); // someone else's leaf first
    const notes = raws.map((raw) => {
      const blinding = randomField();
      const commitment = commitmentOf(BigInt(ASSET), raw, alice().ownerPk, blinding);
      const leafIndex = tree.insert(commitment);
      return { asset: ASSET, raw, ownerPk: alice().ownerPk, blinding, commitment, leafIndex, nullifier: null, spent: false };
    });
    return { tree, notes };
  }

  async function verifies(circuit: "transfer" | "withdraw", proof: Hex, inputs: Hex[]): Promise<boolean> {
    const artifact = JSON.parse(readFileSync(join(import.meta.dir, "..", "src", "vault", "artifacts", `${circuit}.json`), "utf8"));
    const api = await Barretenberg.new({ threads: 2 });
    try {
      const be = new UltraHonkBackend(artifact.bytecode, api);
      return await be.verifyProof({ proof: hexToBytes(proof), publicInputs: inputs }, { verifierTarget: "evm" });
    } finally {
      await api.destroy();
    }
  }

  test("transfer: 2 notes -> recipient + change; outputs open for their owners; proof verifies", async () => {
    const { tree, notes } = seeded([700n, 500n]);
    const t = await proveTransfer({ keys: alice(), tree, inputs: notes, to: bob(), raw: 900n });
    expect(t.outputs.map((o) => o.raw)).toEqual([900n, 300n]);
    expect(decryptNote(t.encryptedNotes[0], bob().viewingSecret)).toMatchObject({ raw: 900n, asset: ASSET });
    expect(decryptNote(t.encryptedNotes[1], alice().viewingSecret)).toMatchObject({ raw: 300n });
    expect(t.pub.root).toBe(toBytes32(tree.root()));
    expect(t.pub.nullifiers[0]).toBe(toBytes32(nullifierOf(notes[0]!.commitment, alice().spendingSecret, 1n)));
    const inputs = [t.pub.root, ...t.pub.nullifiers, ...t.pub.outCommitments, toBytes32(BigInt(ASSET)), toBytes32(extHashOf(encodeTwoNotes(t.encryptedNotes[0], t.encryptedNotes[1])))];
    expect(await verifies("transfer", t.proof, inputs)).toBe(true);
    const flipped = [...inputs];
    flipped[3] = toBytes32(BigInt(flipped[3]!) ^ 1n);
    expect(await verifies("transfer", t.proof, flipped)).toBe(false);

    const tx = transferTx(RECIPIENT, t);
    const dec = decodeFunctionData({ abi: shieldedPoolAbi, data: tx.data });
    expect(dec.functionName).toBe("transfer");
    expect((dec.args![1] as any).nullifiers).toEqual(t.pub.nullifiers);
  }, 60_000);

  test("transfer with one input adds a zero dummy; overspend and spent notes are refused", async () => {
    const { tree, notes } = seeded([400n]);
    const t = await proveTransfer({ keys: alice(), tree, inputs: notes, to: bob(), raw: 400n });
    expect(t.outputs.map((o) => o.raw)).toEqual([400n, 0n]);
    expect(t.pub.nullifiers[0]).not.toBe(t.pub.nullifiers[1]);
    expect(BigInt(t.pub.outCommitments[1])).toBe(0n); // S8: the zero change takes no leaf
    expect(t.encryptedNotes[1]).toBe("0x");
    await expect(proveTransfer({ keys: alice(), tree, inputs: notes, to: bob(), raw: 401n })).rejects.toThrow(/cannot send/);
    await expect(proveTransfer({ keys: alice(), tree, inputs: [{ ...notes[0]!, spent: true }], to: bob(), raw: 1n })).rejects.toThrow(/spent/);
    await expect(proveTransfer({ keys: alice(), tree, inputs: [{ ...notes[0]!, leafIndex: null }], to: bob(), raw: 1n })).rejects.toThrow(/pending/);
  }, 60_000);

  test("withdraw: public inputs in circuit order, relayer request round-trips, fee <= amount", async () => {
    const { tree, notes } = seeded([1_000n]);
    const w = await proveWithdraw({ keys: alice(), tree, note: notes[0]!, amount: 600n, recipient: RECIPIENT, relayerFee: 5n, relayer: RELAYER });
    const inputs = [w.pub.root, w.pub.nullifier, w.pub.changeCommitment, toBytes32(BigInt(ASSET)), toBytes32(600n), toBytes32(BigInt(RECIPIENT)), toBytes32(5n), toBytes32(extHashOf(withdrawExtData(w.pub.encryptedChange, 5n, RELAYER)))];
    expect(await verifies("withdraw", w.proof, inputs)).toBe(true);
    // L-9: the fee is bound to RELAYER; the same proof submitted by anyone else (ext hash with their address) fails
    expect(await verifies("withdraw", w.proof, [...inputs.slice(0, 7), toBytes32(extHashOf(withdrawExtData(w.pub.encryptedChange, 5n, RECIPIENT)))])).toBe(false);
    expect(await verifies("withdraw", w.proof, [...inputs.slice(0, 7), toBytes32(extHashOf(w.pub.encryptedChange))])).toBe(false);
    await expect(proveWithdraw({ keys: alice(), tree, note: notes[0]!, amount: 600n, recipient: RECIPIENT, relayerFee: 5n })).rejects.toThrow(/relayer's address/);
    expect(withdrawExtData(w.pub.encryptedChange, 0n)).toBe(w.pub.encryptedChange); // fee-less: unchanged ext data
    expect(decryptNote(w.pub.encryptedChange, alice().viewingSecret)).toMatchObject({ raw: 400n });
    await expect(proveWithdraw({ keys: alice(), tree, note: notes[0]!, amount: 10n, recipient: RECIPIENT, relayerFee: 11n })).rejects.toThrow(/fee/);
    await expect(proveWithdraw({ keys: alice(), tree, note: notes[0]!, amount: 1_001n, recipient: RECIPIENT })).rejects.toThrow(/cannot withdraw/);

    const req = withdrawRequest(w);
    expect(req.pub.amount).toBe("600");
    let seen: any;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ txHash: `0x${"11".repeat(32)}` }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await submitWithdraw("http://relayer/", w, fake)).toBe(`0x${"11".repeat(32)}`);
    expect(seen.url).toBe("http://relayer/withdraw");
    expect(seen.body.pub.relayerFee).toBe("5");
    const bad = (async () => new Response(JSON.stringify({ error: "note already spent" }), { status: 409 })) as unknown as typeof fetch;
    await expect(submitWithdraw("http://relayer", w, bad)).rejects.toThrow(/already spent/);

    const dec = decodeFunctionData({ abi: shieldedPoolAbi, data: withdrawTx(RECIPIENT, w).data });
    expect((dec.args![1] as any).recipient).toBe(RECIPIENT);
  }, 60_000);

  test("depositTx: commitment matches and the note opens for the recipient", () => {
    const d = depositTx(RECIPIENT, ASSET, 77n, bob());
    const dec = decodeFunctionData({ abi: shieldedPoolAbi, data: d.data });
    const [asset, raw, ownerPk, blinding, enc] = dec.args as [string, bigint, Hex, Hex, Hex];
    expect(raw).toBe(77n);
    expect(BigInt(ownerPk)).toBe(bob().ownerPk);
    expect(commitmentOf(BigInt(asset), raw, BigInt(ownerPk), BigInt(blinding))).toBe(d.commitment);
    expect(decryptNote(enc, bob().viewingSecret)).toEqual({ asset: ASSET, raw: 77n, blinding: d.blinding });
    expect(() => depositTx(RECIPIENT, ASSET, 0n, bob())).toThrow();
    expect(() => depositTx(RECIPIENT, ASSET, 1n << 128n, bob())).toThrow();
  });
});
