// Writes the JSON fixture that contracts/test/treasury/PolicyCompilerFixture.t.sol reads, so the Merkle root,
// proofs and policy hash computed here are checked against Solidity (MerkleProof.verify, abi.encode).
// 32-byte values are written as decimal strings: forge parses them, and they cannot be mistaken for keys.
// Run: bun packages/policy-compiler/src/fixture.ts   (the bun test fails if the committed file is stale)
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileFile } from "./index";

export const REPO = resolve(import.meta.dir, "../../..");
export const TEMPLATES = ["conservative", "balanced", "carry"] as const;
export const FIXTURE_CONTROLLER = "0x000000000000000000000000000000000000C0DE";
export const FIXTURE_PATH = join(REPO, "contracts/test/treasury/fixtures/policy-compiler.json");

const dec = (h: string) => BigInt(h).toString();

export function buildFixture() {
  const out: Record<string, unknown> = { controller: FIXTURE_CONTROLLER, templates: [...TEMPLATES] };
  for (const name of TEMPLATES) {
    const c = compileFile(join(REPO, "templates", `${name}.yaml`), { controller: FIXTURE_CONTROLLER });
    const p = c.policy;
    out[name] = {
      cashMin: p.cash.minBps,
      cashMax: p.cash.maxBps,
      equityMin: p.equity.minBps,
      equityMax: p.equity.maxBps,
      basisMin: p.basis.minBps,
      basisMax: p.basis.maxBps,
      netDeltaMinBps: p.netDeltaMinBps,
      netDeltaMaxBps: p.netDeltaMaxBps,
      maxLeverageX10: p.maxLeverageX10,
      perOrderCapUsd: p.perOrderCapUsd.toString(),
      perDayCapUsd: p.perDayCapUsd.toString(),
      perNameFloatCapBps: p.perNameFloatCapBps,
      perVenueCapBps: p.perVenueCapBps,
      noNewRiskOffHours: p.noNewRiskOffHours,
      pauseNewRiskAtDrawdownBps: p.pauseNewRiskAtDrawdownBps,
      deriskAtDrawdownBps: p.deriskAtDrawdownBps,
      approvalAboveUsd: p.approvalAboveUsd.toString(),
      periodSeconds: p.periodSeconds,
      instrumentAllowRoot: dec(p.instrumentAllowRoot),
      venueAllowRoot: dec(p.venueAllowRoot),
      controller: p.controller,
      hash: dec(c.hash),
      leafCount: c.instruments.length,
      leaves: c.instruments.map((i) => ({ asset: i.asset, kind: i.kind, proof: i.proof.map(dec) })),
    };
  }
  return out;
}

export const fixtureText = () => `${JSON.stringify(buildFixture(), null, 2)}\n`;

if (import.meta.main) {
  writeFileSync(FIXTURE_PATH, fixtureText());
  console.log(`wrote ${FIXTURE_PATH}`);
}
