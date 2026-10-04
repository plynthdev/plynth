// Hidden Vault circuits: TS note model == Noir, shared constants in sync, generated
// verifiers and fixtures up to date, client-side proving fast enough.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import constants from "../constants.json" with { type: "json" };
import { CONSTANTS_SOL, FIXTURE_PATH, computeFixtures, constantsSol } from "./fixtures";
import { keccak256, toHex } from "viem";
import { P, hex, buildTree, commitment, hash, initNote, nullifier, ownerPk, permutation, zeroHashes, TREE_DEPTH } from "./note";
import { prove, transferInputs, withdrawInputs } from "./prove";

const circuits = join(import.meta.dir, "..");
const home = process.env.HOME ?? "";
const PATH = `${home}/.nargo/bin:${home}/.bb:${process.env.PATH}`;
const has = (bin: string) => spawnSync(bin, ["--version"], { env: { ...process.env, PATH } }).status === 0;
const toolchain = has("nargo") && has("bb");
if (!toolchain) console.warn("nargo/bb not installed: skipping circuit build, freshness and proving tests (see circuits/VERSIONS)");

const fx = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const big = (xs: string[]) => xs.map((x) => BigInt(x));

beforeAll(async () => {
  await initNote();
  if (toolchain) {
    const r = spawnSync("bash", [join(circuits, "scripts/build.sh")], {
      env: { ...process.env, PATH, OUT_DIR: mkdtempSync(join(tmpdir(), "plynth-verifiers-")) },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`build.sh failed: ${r.stderr}`);
  }
}, 120_000);

describe("shared constants", () => {
  test("constants.nr matches constants.json", () => {
    const nr = readFileSync(join(circuits, "hidden/src/constants.nr"), "utf8");
    expect(nr).toContain(`pub global TREE_DEPTH: u32 = ${constants.treeDepth};`);
    expect(nr).toContain(`pub global ZERO_LEAF: Field = ${hex(BigInt(constants.zeroLeaf))};`);
  });
  test("HiddenConstants.sol is generated from the Noir zero subtrees", () => {
    expect(readFileSync(CONSTANTS_SOL, "utf8")).toBe(constantsSol(fx.zeros));
  });
  test("zero leaf is keccak256(preimage) mod p", () => {
    expect(BigInt(keccak256(toHex(constants.zeroLeafPreimage))) % P).toBe(BigInt(constants.zeroLeaf));
  });
});

describe("TS note model equals Noir", () => {
  test("permutation on 100 fixture states", () => {
    fx.states.forEach((s: string[], i: number) => expect(permutation(big(s))).toEqual(big(fx.perms[i])));
  });
  test("sponge for 1..4 inputs on 100 fixture rows", () => {
    for (let i = 0; i < 100; i++) {
      const [a, b, c, d] = [fx.a[i], fx.b[i], fx.c[i], fx.d[i]].map(BigInt) as [bigint, bigint, bigint, bigint];
      expect(hash([a])).toBe(BigInt(fx.h1[i]));
      expect(hash([a, b])).toBe(BigInt(fx.h2[i]));
      expect(hash([a, b, c])).toBe(BigInt(fx.h3[i]));
      expect(hash([a, b, c, d])).toBe(BigInt(fx.h4[i]));
    }
  });
  test("stdlib Poseidon2Hasher known digest", () => {
    expect(hash([1n, 2n, 3n, 4n, 5n])).toBe(0x2247be7014a54d17342a7ef677f58d28877780d203860396967f5d0a18d259dbn); // not-a-key
  });
  test("zero subtrees", () => {
    expect(zeroHashes()).toEqual(big(fx.zeros));
  });
  test("sparse tree paths open to the root", () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const t = buildTree(leaves);
    leaves.forEach((leaf, i) => {
      let node = leaf;
      t.path(i).forEach((sib, d) => (node = (i >> d) & 1 ? hash([sib, node]) : hash([node, sib])));
      expect(node).toBe(t.root);
    });
    expect(buildTree([]).root).toBe(zeroHashes()[TREE_DEPTH]!);
  });
});

describe.skipIf(!toolchain)("generated artifacts are fresh", () => {
  test("Solidity verifiers match the current circuits", () => {
    const out = mkdtempSync(join(tmpdir(), "plynth-verifiers-"));
    const r = spawnSync("bash", [join(circuits, "scripts/build.sh")], { env: { ...process.env, PATH, OUT_DIR: out }, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const name of ["TransferVerifier.sol", "WithdrawVerifier.sol", "ThresholdHoldingsVerifier.sol", "ThresholdSavingsVerifier.sol"]) {
      const committed = readFileSync(join(circuits, "../contracts/src/consumer/verifiers", name), "utf8");
      expect(readFileSync(join(out, name), "utf8")).toBe(committed);
    }
  }, 120_000);
  test("poseidon2 fixtures match a fresh Noir execution", async () => {
    const fresh = await computeFixtures();
    expect(fresh).toEqual(fx);
  });
});

describe.skipIf(!toolchain)("client-side proving", () => {
  const LIMIT_MS = 10_000;
  for (const [name, inputs] of [["transfer", transferInputs], ["withdraw", withdrawInputs]] as const) {
    test(`${name}: proof verifies and proving stays under 10 s`, async () => {
      const r = await prove(name, inputs());
      console.log(`${name}: witness ${r.witnessMs} ms, prove ${r.proveMs} ms`);
      expect(r.witnessMs + r.proveMs).toBeLessThan(LIMIT_MS);
      const committed = JSON.parse(readFileSync(join(circuits, `../contracts/test/consumer/verifiers/fixtures/${name}_proof.json`), "utf8"));
      // ZK proofs are randomised; the public inputs are deterministic.
      expect(r.publicInputs.map((x) => BigInt(x).toString())).toEqual(committed.publicInputs);
    }, 60_000);
  }
  test("transfer: inflation cannot produce a witness", async () => {
    const i = transferInputs();
    i.outputs[0]!.amount = "0x" + (900_001n).toString(16);
    const asset = BigInt(i.asset_id);
    i.out_commitments[0] = "0x" + commitment(asset, 900_001n, BigInt(i.outputs[0]!.owner_pk), BigInt(i.outputs[0]!.blinding)).toString(16).padStart(64, "0");
    await expect(prove("transfer", i)).rejects.toThrow(/value not conserved/);
  }, 60_000);
  test("withdraw: a note not in the tree cannot be spent", async () => {
    const i = withdrawInputs();
    i.root = "0x" + (BigInt(i.root) + 1n).toString(16);
    await expect(prove("withdraw", i)).rejects.toThrow(/input note not in tree/);
  }, 60_000);
  test("nullifier/commitment helpers match the transfer fixture", () => {
    const i = transferInputs();
    const asset = BigInt(i.asset_id);
    const c0 = commitment(asset, BigInt(i.inputs[0]!.amount), ownerPk(BigInt(i.inputs[0]!.secret)), BigInt(i.inputs[0]!.blinding));
    expect(nullifier(c0, BigInt(i.inputs[0]!.secret), 0n)).toBe(BigInt(i.nullifiers[0]!));
  });
});

test("fixtures directory exists", () => {
  expect(existsSync(FIXTURE_PATH)).toBe(true);
});
