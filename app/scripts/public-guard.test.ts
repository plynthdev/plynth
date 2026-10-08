import { expect, test } from "bun:test";
import { join } from "node:path";

// Runs the shell test suite for .githooks/public-guard.sh so `bun test` covers it.
const HOOKS = join(import.meta.dir, "..", "..", ".githooks");

test("public-guard rejects every forbidden thing and passes a clean repo", () => {
  const r = Bun.spawnSync(["bash", join(HOOKS, "test-public-guard.sh")], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) console.error(out);
  expect(out).toContain("0 failed");
  expect(r.exitCode).toBe(0);
}, 300_000);

test("public-guard is clean on this repo", () => {
  const r = Bun.spawnSync(["bash", join(HOOKS, "public-guard.sh")], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) console.error(r.stdout.toString());
  expect(r.exitCode).toBe(0);
}, 300_000); // one pass over every file; minutes on a loaded CI host (this Mac also runs the agents)
