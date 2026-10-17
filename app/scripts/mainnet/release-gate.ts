// Release gate for a mainnet deployment (review v2 L-20): the deploy is not released (services started, README
// regenerated, users invited) until both strict checks pass against the chain:
//
//   1. forge script MainnetBeta.s.sol --sig "verifyDeploymentStrict(string)" <file>   the deploy script's own
//      checkHandoff against the file, failing while any two-step hand-over is pending (deployer still owns)
//   2. bun scripts/verify-deployment.ts --strict --file deployments/<file>           every owner, role, timer, feed,
//      pool, cap, perp guard and the holiday table expiry; pending hand-overs FAIL
//
//   bun run release:gate                                  # app/deployments/4663.json on the public RPC
//   bun run release:gate --file fork.json --rpc http://127.0.0.1:16545   # a fork dry run (chain 31337)
//
// Run it after OWNER's acceptOwnership calls (runbook: deploy, accept, setup.ts, then this gate, then up.sh) and
// whenever the deployment file changes; CI runs it daily against the recorded mainnet file. A v1 file (no
// allowEoaOwner / calendarValidUntil) predates verifyDeploymentStrict: only step 2 runs for it. Read-only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentVersion } from "../verify-deployment";
import { APP, ROOT, RPC } from "./lib";

export type Step = { name: string; cmd: string[]; cwd: string };

/** MainnetBeta.checkOutName: a plain file name inside app/deployments. */
export const isPlainName = (f: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(f);

/** The gate's steps for one deployment file (a name inside app/deployments) and RPC. */
export function gatePlan(file: string, dep: Record<string, unknown>, rpc: string): { steps: Step[]; notes: string[] } {
  if (!isPlainName(file)) throw new Error(`--file must be a file name inside app/deployments (MainnetBeta.checkOutName), got ${file}`);
  const steps: Step[] = [];
  const notes: string[] = [];
  if (deploymentVersion(dep) === 2) {
    steps.push({
      name: "forge MainnetBeta.verifyDeploymentStrict",
      cmd: ["forge", "script", "script/MainnetBeta.s.sol:MainnetBeta", "--sig", "verifyDeploymentStrict(string)", file, "--rpc-url", rpc],
      cwd: join(ROOT, "contracts"),
    });
  } else {
    notes.push(`${file} is a v1 deployment (no allowEoaOwner / calendarValidUntil): MainnetBeta.verifyDeploymentStrict reads the v2 format, so only verify:deployment --strict runs`);
  }
  steps.push({ name: "verify:deployment --strict", cmd: ["bun", "scripts/verify-deployment.ts", "--strict", "--file", `deployments/${file}`, "--rpc", rpc], cwd: APP });
  return { steps, notes };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const file = arg("file") ?? "4663.json";
  const rpc = arg("rpc") ?? RPC;
  const dep = JSON.parse(readFileSync(join(APP, "deployments", file), "utf8")) as Record<string, unknown>;
  const { steps, notes } = gatePlan(file, dep, rpc);
  for (const n of notes) console.log(`[release gate] note: ${n}`);
  const failed: string[] = [];
  for (const s of steps) {
    console.log(`\n[release gate] ${s.name}: ${s.cmd.join(" ")}`);
    const r = spawnSync(s.cmd[0]!, s.cmd.slice(1), { cwd: s.cwd, stdio: "inherit" });
    if (r.status !== 0) failed.push(s.name);
  }
  console.log(`\n[release gate] ${failed.length ? `FAILED: ${failed.join(", ")}` : `passed (${steps.map((s) => s.name).join(", ")})`} for ${file}`);
  process.exit(failed.length ? 1 : 0);
}
