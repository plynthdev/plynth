// verifyDisclosure must work in a process that never called initVault() (the API verifies bundles statelessly).
// Bun runs test files in one process, where another file may already have loaded Poseidon2, so this runs the
// check in a fresh subprocess.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("verifyDisclosure loads Poseidon2 itself (fresh process, no initVault call)", () => {
  const script = `
    import { verifyDisclosure } from ${JSON.stringify(join(import.meta.dir, "..", "src", "statements", "disclosure.ts"))};
    const f = "0x" + "00".repeat(31) + "01";
    const bundle = { version: 1, kind: "plynth.disclosure", chainId: 31337, pool: "0x0000000000000000000000000000000000000001",
      period: { fromBlock: "1", toBlock: "5" }, root: f,
      notes: [{ asset: "0x0000000000000000000000000000000000000002", raw: "1", ownerPk: f, blinding: f, leafIndex: 0, path: Array(20).fill(f) }] };
    const pub = { getChainId: async () => 31337, getBlockNumber: async () => 10n, getLogs: async () => [] };
    const v = await verifyDisclosure(pub, bundle, {});
    console.log(JSON.stringify({ ok: v.ok, error: v.notes[0].error, commitment: v.notes[0].commitment }));
  `;
  const r = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(r.exitCode, out).toBe(0);
  const v = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(v.ok).toBe(false);
  expect(v.error).toBe("commitment is not in the pool's tree at this leaf");
  expect(v.commitment).toMatch(/^0x[0-9a-f]{64}$/);
}, 60_000);
