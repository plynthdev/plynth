import { expect, test } from "bun:test";
import { join } from "node:path";

// Runs the shell test suite for scripts/public-guard.sh so `bun test` covers it.
test("public-guard rejects every forbidden thing and passes a clean repo", () => {
  const r = Bun.spawnSync(["bash", join(import.meta.dir, "test-public-guard.sh")], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) console.error(out);
  expect(out).toContain("0 failed");
  expect(r.exitCode).toBe(0);
}, 60_000);

test("public-guard is clean on this repo", () => {
  const r = Bun.spawnSync(["bash", join(import.meta.dir, "public-guard.sh")], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) console.error(r.stdout.toString());
  expect(r.exitCode).toBe(0);
}, 60_000);
