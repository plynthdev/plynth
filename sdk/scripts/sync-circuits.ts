// Copies the compiled Hidden Vault circuits (circuits/<c>/target/<c>.json, built by circuits/scripts/build.sh)
// into sdk/src/vault/artifacts, keeping only what noir_js and bb.js need (no debug info or sources).
//   bash circuits/scripts/build.sh && bun sdk/scripts/sync-circuits.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
export const CIRCUITS = ["transfer", "withdraw", "threshold_holdings", "threshold_savings", "swap", "settle"] as const;

export function compactArtifact(circuit: string): string {
  const full = JSON.parse(readFileSync(join(root, "circuits", circuit, "target", `${circuit}.json`), "utf8"));
  const { noir_version, hash, abi, bytecode } = full;
  return JSON.stringify({ noir_version, hash, abi, bytecode }) + "\n";
}

if (import.meta.main) {
  for (const c of CIRCUITS) {
    writeFileSync(join(root, "sdk", "src", "vault", "artifacts", `${c}.json`), compactArtifact(c));
    console.log(`${c}: synced`);
  }
}
