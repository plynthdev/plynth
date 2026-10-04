// ShieldedTrade SDK (todo 25): v2 note model == circuits, swap/settle proofs verify against the artifacts,
// v2 notes are found by their PartialNoteFilled amount, and transfer/withdraw refuse unsettled v2 notes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import settleArtifact from "../src/vault/artifacts/settle.json" with { type: "json" };
import swapArtifact from "../src/vault/artifacts/swap.json" with { type: "json" };
import {
  NoteTree,
  NOTE_VERSION_PARTIAL,
  TradeKind,
  balances,
  commitmentOf,
  commitmentV2Of,
  decryptNote,
  decryptNoteAny,
  deriveVaultKeys,
  destroyProver,
  emptyState,
  encryptNote,
  hash,
  initVault,
  minOutFor,
  myNotes,
  noteCommitment,
  nullifierOf,
  partialCommitmentOf,
  proveSettle,
  proveSwap,
  proveWithdraw,
  randomField,
  settleTx,
  shieldedTradeAbi,
  swapTx,
  toBytes32,
  verifyCircuitProof,
  type OwnedNote,
} from "../src/vault";

const STOCK = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const USDG = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const TRADE = getAddress("0x0000000000000000000000000000000000007a0e");
const sig = (b: string) => `0x${b.repeat(65)}` as Hex;
const alice = () => deriveVaultKeys(sig("a1"));
const bob = () => deriveVaultKeys(sig("b0"));

beforeAll(async () => {
  await initVault();
});
afterAll(async () => {
  await destroyProver();
});

function seeded(asset: `0x${string}`, raw: bigint, version: 1 | 2 = 1): { tree: NoteTree; note: OwnedNote } {
  const tree = new NoteTree();
  tree.insert(123n);
  const blinding = randomField();
  const n = { asset, raw, ownerPk: alice().ownerPk, blinding, version };
  const commitment = noteCommitment(n);
  const leafIndex = tree.insert(commitment);
  return { tree, note: { ...n, commitment, leafIndex, nullifier: null, spent: false } };
}

describe("v2 note model", () => {
  test("partial and v2 commitment are the circuit's H(asset, pk, blinding) and H(partial, amount)", () => {
    const pk = alice().ownerPk;
    const partial = partialCommitmentOf(BigInt(USDG), pk, 7n);
    expect(partial).toBe(hash([BigInt(USDG), pk, 7n]));
    expect(commitmentV2Of(partial, 100n)).toBe(hash([partial, 100n]));
    expect(noteCommitment({ asset: USDG, raw: 100n, ownerPk: pk, blinding: 7n, version: 2 })).toBe(commitmentV2Of(partial, 100n));
    expect(noteCommitment({ asset: USDG, raw: 100n, ownerPk: pk, blinding: 7n })).toBe(commitmentOf(BigInt(USDG), 100n, pk, 7n));
    expect(commitmentV2Of(partial, 100n)).not.toBe(commitmentOf(BigInt(USDG), 100n, pk, 7n));
  });

  test("v2 encrypted notes carry version 2; decryptNote (v1 only) ignores them", () => {
    const enc = encryptNote({ asset: USDG, raw: 5n, blinding: 9n }, alice().viewingPub, NOTE_VERSION_PARTIAL);
    expect(decryptNoteAny(enc, alice().viewingSecret)).toEqual({ asset: USDG, raw: 5n, blinding: 9n, version: 2 });
    expect(decryptNote(enc, alice().viewingSecret)).toBeNull();
    expect(decryptNoteAny(enc, bob().viewingSecret)).toBeNull();
  });

  test("wallet scan finds a v2 note only with its PartialNoteFilled amount", () => {
    const me = alice();
    const blinding = randomField();
    const partial = partialCommitmentOf(BigInt(USDG), me.ownerPk, blinding);
    const commitment = commitmentV2Of(partial, 1_234n);
    const data = encryptNote({ asset: USDG, raw: 1_000n /* the proof's minOut */, blinding }, me.viewingPub, 2);
    const s = emptyState();
    s.encrypted.push({ commitment, data });
    s.leafOf.set(commitment, s.tree.insert(commitment));
    expect(myNotes(s, me)).toEqual([]); // no fill seen yet
    s.partials.set(partial, { commitment: commitment + 1n, amount: 1_234n }); // wrong commitment: ignored
    expect(myNotes(s, me)).toEqual([]);
    s.partials.set(partial, { commitment, amount: 1_234n });
    const [n] = myNotes(s, me);
    expect(n).toMatchObject({ asset: USDG, raw: 1_234n, version: 2, leafIndex: 0, spent: false });
    expect(n!.nullifier).toBe(nullifierOf(commitment, me.spendingSecret, 0n));
    expect(balances(myNotes(s, me)).get(USDG)).toBe(1_234n);
    expect(myNotes(s, bob())).toEqual([]);
  });
});

describe("swap and settle proofs", () => {
  test("private sell: proof verifies, change opens for the owner, output is a partial note", async () => {
    const { tree, note } = seeded(STOCK, 10n ** 18n);
    const s = await proveSwap({ keys: alice(), tree, note, amountIn: 4n * 10n ** 17n, assetOut: USDG, minOut: 99_000_000n, deadline: 1_800_000_000n, relayerFee: 10n ** 15n });
    expect(s.pub).toMatchObject({ assetIn: STOCK, assetOut: USDG, amountIn: 4n * 10n ** 17n, relayerFee: 10n ** 15n, minOut: 99_000_000n, deadline: 1_800_000_000n });
    expect(s.pub.root).toBe(toBytes32(tree.root()));
    expect(s.pub.nullifier).toBe(toBytes32(nullifierOf(note.commitment, alice().spendingSecret, 1n)));
    expect(BigInt(s.pub.outPartial)).toBe(partialCommitmentOf(BigInt(USDG), alice().ownerPk, s.out.blinding));
    expect(decryptNote(s.encryptedChange, alice().viewingSecret)).toMatchObject({ asset: STOCK, raw: 6n * 10n ** 17n });
    expect(decryptNoteAny(s.encryptedOut, alice().viewingSecret)).toMatchObject({ asset: USDG, version: 2, blinding: s.out.blinding });
    const inputs = [s.pub.root, s.pub.nullifier, s.pub.changeCommitment, BigInt(STOCK), s.pub.amountIn, s.pub.relayerFee, BigInt(USDG), s.pub.minOut, s.pub.outPartial, s.pub.deadline].map((x) => BigInt(x));
    expect(await verifyCircuitProof(swapArtifact, s.proof, inputs)).toBe(true);
    inputs[7] = 1n; // a relayer lowering minOut
    expect(await verifyCircuitProof(swapArtifact, s.proof, inputs)).toBe(false);

    const tx = swapTx(TRADE, s, 150);
    const d = decodeFunctionData({ abi: shieldedTradeAbi, data: tx.data });
    expect(d.functionName).toBe("swap");
    expect(d.args![2]).toBe(150);
    expect(tx.to).toBe(TRADE);
  }, 60_000);

  test("a v2 note can be swapped again (buy) and settled; transfer/withdraw refuse it unsettled", async () => {
    const { tree, note } = seeded(USDG, 1_000_000_000n, 2);
    await expect(proveWithdraw({ keys: alice(), tree, note, amount: 1n, recipient: USDG })).rejects.toThrow(/settle it first/);
    const b = await proveSwap({ keys: alice(), tree, note, amountIn: note.raw, assetOut: STOCK, minOut: 1n, deadline: 1_800_000_000n, to: bob() });
    expect(BigInt(b.pub.outPartial)).toBe(partialCommitmentOf(BigInt(STOCK), bob().ownerPk, b.out.blinding));
    expect(decryptNoteAny(b.encryptedOut, bob().viewingSecret)).toMatchObject({ asset: STOCK, version: 2 });
    expect(decryptNote(b.encryptedChange, alice().viewingSecret)).toMatchObject({ raw: 0n });

    const st = await proveSettle({ keys: alice(), tree, note });
    expect(BigInt(st.outCommitment)).toBe(commitmentOf(BigInt(USDG), note.raw, alice().ownerPk, st.out.blinding));
    expect(decryptNote(st.encryptedOut, alice().viewingSecret)).toEqual({ asset: USDG, raw: note.raw, blinding: st.out.blinding });
    expect(await verifyCircuitProof(settleArtifact, st.proof, [st.root, st.nullifier, st.outCommitment].map((x) => BigInt(x)))).toBe(true);
    const d = decodeFunctionData({ abi: shieldedTradeAbi, data: settleTx(TRADE, st).data });
    expect(d.functionName).toBe("settle");
  }, 60_000);

  test("input checks", async () => {
    const { tree, note } = seeded(STOCK, 1000n);
    const base = { keys: alice(), tree, note, assetOut: USDG, minOut: 0n, deadline: 1n };
    await expect(proveSwap({ ...base, amountIn: 1001n })).rejects.toThrow(/cannot swap/);
    await expect(proveSwap({ ...base, amountIn: 0n })).rejects.toThrow(/cannot swap/);
    await expect(proveSwap({ ...base, amountIn: 10n, relayerFee: 10n })).rejects.toThrow(/relayer fee/);
    await expect(proveSwap({ ...base, amountIn: 10n, assetOut: STOCK })).rejects.toThrow(/same asset/);
    await expect(proveSettle({ keys: alice(), tree, note })).rejects.toThrow(/only v2/);
    await expect(proveSwap({ ...base, amountIn: 10n, note: { ...note, spent: true } })).rejects.toThrow(/already spent/);
  });

  test("minOutFor and kinds", () => {
    expect(minOutFor(1_000_000n, 100)).toBe(990_000n);
    expect(minOutFor(999n, 0)).toBe(999n);
    expect(() => minOutFor(1n, 10_001)).toThrow();
    expect(TradeKind).toEqual({ Buy: 0, Sell: 1, Park: 2, Unpark: 3 });
  });
});
