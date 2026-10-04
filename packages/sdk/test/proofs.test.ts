// Threshold proofs without a chain: real UltraHonk proofs checked against the shipped verification keys
// (verifyProofOnly), note/deposit selection, the nonce binding, and bundle shape checks. On-chain checks (known
// roots, spent nullifiers, deposit-tree windows) are in contracts/test/consumer/ThresholdVerifier.t.sol and the
// anvil end-to-end in apps/api/test/proofs.anvil.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";
import holdingsArtifact from "../src/vault/artifacts/threshold_holdings.json" with { type: "json" };
import {
  MAX_THRESHOLD_NOTES,
  ThresholdNotMet,
  checkThresholdShape,
  proveHoldingsAtLeast,
  proveSavingsAtLeast,
  verifierNonce,
  verifyHoldings,
  verifyProofOnly,
  verifyThresholdProof,
  type DepositTreeState,
  type HoldingsProof,
  type SavingsProof,
} from "../src/statements";
import { NoteTree, commitmentOf, deriveVaultKeys, destroyProver, initVault, nullifierOf, proveCircuit, toBytes32, type OwnedNote, type VaultKeys } from "../src/vault";

const ASSET = "0x00000000000000000000000000000000000A55E7" as Address;
const OTHER = "0x0000000000000000000000000000000000000B0B" as Address;
const TV = "0x0000000000000000000000000000000000007e57" as Address;
const A = "0x000000000000000000000000000000000000aAaA" as Address;
const B = "0x000000000000000000000000000000000000bBbB" as Address;
const REQ = keccak256(toBytes("plynth.test.request.1"));
const reqA = { chainId: 31337, thresholdVerifier: TV, verifier: A, requestId: REQ };
const reqB = { ...reqA, verifier: B };
const sig = (b: string) => `0x${b.repeat(65)}` as Hex;
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "contracts", "test", "consumer", "fixtures", "threshold.json"), "utf8"));

let me: VaultKeys;
let other: VaultKeys;
beforeAll(async () => {
  await initVault();
  me = deriveVaultKeys(sig("a1"));
  other = deriveVaultKeys(sig("b0"));
});
afterAll(destroyProver);

/** A pool tree with notes in insertion order; returns my OwnedNotes. */
function pool(entries: { keys: VaultKeys; raw: bigint; asset?: Address }[]) {
  const tree = new NoteTree();
  const notes: (OwnedNote & { keys: VaultKeys })[] = entries.map((e, i) => {
    const asset = e.asset ?? ASSET;
    const blinding = BigInt(1000 + i);
    const commitment = commitmentOf(BigInt(asset), e.raw, e.keys.ownerPk, blinding);
    const leafIndex = tree.insert(commitment);
    return { keys: e.keys, asset, raw: e.raw, ownerPk: e.keys.ownerPk, blinding, commitment, leafIndex, nullifier: null, spent: false };
  });
  return { tree, mine: notes.filter((n) => n.keys === me) };
}

describe("verifier nonce", () => {
  test("matches ThresholdVerifier.nonceFor (fixture checked by forge) and is per verifier, request, chain and contract", () => {
    expect(verifierNonce(reqA).toString()).toBe(fixture.nonceA);
    const n = verifierNonce(reqA);
    expect(verifierNonce(reqB)).not.toBe(n);
    expect(verifierNonce({ ...reqA, requestId: keccak256(toBytes("other")) })).not.toBe(n);
    expect(verifierNonce({ ...reqA, chainId: 46630 })).not.toBe(n);
    expect(verifierNonce({ ...reqA, thresholdVerifier: OTHER })).not.toBe(n);
  });
});

describe("holdings", () => {
  let proof: HoldingsProof;
  let setup: ReturnType<typeof pool>;
  beforeAll(async () => {
    setup = pool([
      { keys: other, raw: 5_000n },
      { keys: me, raw: 100_000n },
      { keys: me, raw: 200_000n },
      { keys: me, raw: 300_000n },
      { keys: me, raw: 900_000n, asset: OTHER },
    ]);
    proof = await proveHoldingsAtLeast({ ...reqA, keys: me, tree: setup.tree, notes: setup.mine, asset: ASSET, threshold: 450_000n });
  }, 60_000);

  test("true statement verifies against the shipped key", async () => {
    expect(await verifyProofOnly(proof, reqA)).toBe(true);
    expect(proof.claim.root).toBe(toBytes32(setup.tree.root()));
    expect(proof.claim.threshold).toBe("450000");
  }, 60_000);

  test("uses the fewest notes (largest first): 300_000 + 200_000, six padding slots with zero nullifiers", () => {
    const real = proof.claim.nullifiers.filter((n) => BigInt(n) !== 0n);
    expect(proof.claim.nullifiers).toHaveLength(MAX_THRESHOLD_NOTES);
    expect(real).toEqual(
      [3, 2].map((i) => toBytes32(nullifierOf(setup.mine.find((n) => n.leafIndex === i)!.commitment, me.spendingSecret, BigInt(i)))),
    );
  });

  test("proof for verifier A is rejected for verifier B (and for another request)", async () => {
    expect(await verifyProofOnly(proof, reqB)).toBe(false);
    expect(await verifyProofOnly(proof, { ...reqA, requestId: keccak256(toBytes("again")) })).toBe(false);
  }, 60_000);

  test("a raised threshold or a dropped nullifier no longer verifies", async () => {
    expect(await verifyProofOnly({ ...proof, claim: { ...proof.claim, threshold: "450001" } }, reqA)).toBe(false);
    const nullifiers = [...proof.claim.nullifiers];
    nullifiers[0] = toBytes32(0n);
    expect(await verifyProofOnly({ ...proof, claim: { ...proof.claim, nullifiers } }, reqA)).toBe(false);
  }, 60_000);

  test("threshold above actual holdings fails to prove (SDK refuses; the circuit refuses too)", async () => {
    await expect(proveHoldingsAtLeast({ ...reqA, keys: me, tree: setup.tree, notes: setup.mine, asset: ASSET, threshold: 600_001n })).rejects.toBeInstanceOf(ThresholdNotMet);
    // Bypass the SDK's selection: a witness for 600_001 from all three notes still fails inside the circuit.
    const t = setup.tree;
    const slots = setup.mine
      .filter((n) => n.asset === ASSET)
      .map((n) => ({ is_real: true, amount: toBytes32(n.raw), blinding: toBytes32(n.blinding), index: toBytes32(BigInt(n.leafIndex!)), path: t.path(n.leafIndex!).map(toBytes32) }));
    const nulls = setup.mine.filter((n) => n.asset === ASSET).map((n) => toBytes32(nullifierOf(n.commitment, me.spendingSecret, BigInt(n.leafIndex!))));
    while (slots.length < 8) slots.push({ is_real: false, amount: toBytes32(0n), blinding: toBytes32(0n), index: toBytes32(0n), path: Array(20).fill(toBytes32(0n)) });
    while (nulls.length < 8) nulls.push(toBytes32(0n));
    const inputs = (threshold: bigint) => ({
      root: toBytes32(t.root()),
      asset_id: toBytes32(BigInt(ASSET)),
      threshold: toBytes32(threshold),
      verifier_nonce: toBytes32(verifierNonce(reqA)),
      nullifier_hashes: nulls,
      secret: toBytes32(me.spendingSecret),
      notes: slots,
    });
    await expect(proveCircuit(holdingsArtifact, inputs(600_001n))).rejects.toThrow();
    expect((await proveCircuit(holdingsArtifact, inputs(600_000n))).proof.startsWith("0x")).toBe(true);
  }, 120_000);

  test("spent, pending and other-asset notes are never counted", async () => {
    const notes = setup.mine.map((n) => (n.raw === 300_000n ? { ...n, spent: true } : n));
    await expect(proveHoldingsAtLeast({ ...reqA, keys: me, tree: setup.tree, notes, asset: ASSET, threshold: 300_001n })).rejects.toBeInstanceOf(ThresholdNotMet);
    const pending = setup.mine.map((n) => (n.raw === 300_000n ? { ...n, leafIndex: null } : n));
    await expect(proveHoldingsAtLeast({ ...reqA, keys: me, tree: setup.tree, notes: pending, asset: ASSET, threshold: 300_001n })).rejects.toBeInstanceOf(ThresholdNotMet);
    await expect(proveHoldingsAtLeast({ ...reqA, keys: me, tree: setup.tree, notes: setup.mine, asset: OTHER, threshold: 900_001n })).rejects.toBeInstanceOf(ThresholdNotMet);
  });

  test("at most 8 notes per proof", async () => {
    const s = pool(Array.from({ length: 9 }, () => ({ keys: me, raw: 10n })));
    await expect(proveHoldingsAtLeast({ ...reqA, keys: me, tree: s.tree, notes: s.mine, asset: ASSET, threshold: 81n })).rejects.toBeInstanceOf(ThresholdNotMet);
    const p = await proveHoldingsAtLeast({ ...reqA, keys: me, tree: s.tree, notes: s.mine, asset: ASSET, threshold: 80n });
    expect(p.claim.nullifiers.every((n) => BigInt(n) !== 0n)).toBe(true);
    expect(await verifyProofOnly(p, reqA)).toBe(true);
  }, 60_000);
});

describe("savings", () => {
  // Pool tree: my 100_000 deposit, someone's 50_000, my 200_000 + 300_000 deposits, then a 250_000 transfer
  // output to me (in the pool tree, never in the deposit tree).
  let s: ReturnType<typeof pool>;
  let dt: DepositTreeState;
  let notes: OwnedNote[];
  beforeAll(() => {
    s = pool([
      { keys: me, raw: 100_000n },
      { keys: other, raw: 50_000n },
      { keys: me, raw: 200_000n },
      { keys: me, raw: 300_000n },
      { keys: me, raw: 250_000n },
    ]);
    const leaves = [0, 1, 2, 3].map((i) => s.tree.leaf(i)!);
    const from = new NoteTree();
    from.insert(leaves[0]!);
    const to = new NoteTree();
    leaves.forEach((l) => to.insert(l));
    dt = { leaves, roots: [{ root: from.root(), size: 1, block: 10n }, { root: to.root(), size: 4, block: 20n }], toBlock: 20n };
    notes = s.mine;
  });
  const prove = (threshold: bigint, from = 0) => proveSavingsAtLeast({ ...reqA, keys: me, deposits: dt, notes, asset: ASSET, threshold, from: dt.roots[from]!, to: dt.roots[1]! });

  test("true statement verifies; bound to verifier A", async () => {
    const p: SavingsProof = await prove(500_000n);
    expect(await verifyProofOnly(p, reqA)).toBe(true);
    expect(await verifyProofOnly(p, reqB)).toBe(false);
    expect(await verifyProofOnly({ ...p, claim: { ...p.claim, threshold: "500001" } }, reqA)).toBe(false);
  }, 60_000);

  test("threshold above the window's deposits fails to prove: earlier deposits and transfer outputs do not count", async () => {
    await expect(prove(500_001n)).rejects.toBeInstanceOf(ThresholdNotMet);
  });

  test("a window from the empty tree counts every deposit", async () => {
    dt.roots.unshift({ root: new NoteTree().root(), size: 0, block: 1n });
    const p = await proveSavingsAtLeast({ ...reqA, keys: me, deposits: dt, notes, asset: ASSET, threshold: 600_000n, from: dt.roots[0]!, to: dt.roots[2]! });
    expect(await verifyProofOnly(p, reqA)).toBe(true);
    dt.roots.shift();
  }, 60_000);

  test("refuses a deposit tree that does not match the roots", async () => {
    const bad = { ...dt, leaves: [...dt.leaves.slice(0, 3), 7n] };
    await expect(proveSavingsAtLeast({ ...reqA, keys: me, deposits: bad, notes, asset: ASSET, threshold: 1n, from: dt.roots[0]!, to: dt.roots[1]! })).rejects.toThrow("rootTo");
  });
});

describe("bundle checks", () => {
  const never = {} as PublicClient; // the checks below return before any RPC call
  const good = {
    version: 1,
    kind: "plynth.threshold.holdings",
    chainId: 31337,
    thresholdVerifier: TV,
    proof: "0x1234",
    claim: { root: toBytes32(1n), asset: ASSET, threshold: "5", nullifiers: Array(8).fill(toBytes32(0n)) },
  };

  test("well-formed bundle has no shape errors", () => {
    expect(checkThresholdShape(good)).toEqual([]);
  });

  test("shape errors", () => {
    expect(checkThresholdShape(null)).toEqual(["bundle must be an object"]);
    expect(checkThresholdShape({ ...good, kind: "x" })).toContain("unknown kind");
    expect(checkThresholdShape({ ...good, claim: { ...good.claim, threshold: (1n << 128n).toString() } })).toContain("claim.threshold must be a decimal string below 2^128");
    expect(checkThresholdShape({ ...good, claim: { ...good.claim, nullifiers: [] } })).toContain("claim.nullifiers must be 8 bytes32");
    expect(checkThresholdShape({ ...good, kind: "plynth.threshold.savings", claim: { asset: ASSET, threshold: "1", rootFrom: "0x01" } })).toContain(
      "claim.rootFrom and claim.rootTo must be bytes32",
    );
  });

  test("malformed, wrong deployment and wrong kind are refused without touching the chain", async () => {
    expect(await verifyThresholdProof(never, { ...good, version: 2 }, { verifier: A, requestId: REQ }, { chainId: 31337, thresholdVerifier: TV })).toMatchObject({ ok: false, reason: "malformed" });
    expect(await verifyThresholdProof(never, good, { verifier: A, requestId: "0x12" as Hex }, { chainId: 31337, thresholdVerifier: TV })).toMatchObject({ ok: false, reason: "malformed" });
    expect(await verifyThresholdProof(never, good, { verifier: A, requestId: REQ }, { chainId: 1, thresholdVerifier: TV })).toEqual({ ok: false, reason: "WrongDeployment" });
    expect(await verifyThresholdProof(never, good, { verifier: A, requestId: REQ }, { chainId: 31337, thresholdVerifier: OTHER })).toEqual({ ok: false, reason: "WrongDeployment" });
    expect(await verifyHoldings(never, { ...good, kind: "plynth.threshold.savings" }, { verifier: A, requestId: REQ }, { chainId: 31337, thresholdVerifier: TV })).toMatchObject({ ok: false });
  });
});
