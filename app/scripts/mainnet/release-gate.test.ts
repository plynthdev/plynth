// The release gate runs the deploy script's strict hand-over check and verify:deployment --strict for a v2 file,
// and only the latter for the v1 file (which predates verifyDeploymentStrict). No chain needed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatePlan, isPlainName } from "./release-gate";

const v1 = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "deployments", "4663.json"), "utf8")) as Record<string, unknown>;
const v2 = { ...v1, allowEoaOwner: false, calendarValidUntil: 1_885_507_200 };
const RPC = "https://rpc.example";

describe("release gate", () => {
  test("a v2 file runs forge verifyDeploymentStrict, then verify:deployment --strict", () => {
    const { steps, notes } = gatePlan("4663.json", v2, RPC);
    expect(notes).toEqual([]);
    expect(steps.map((s) => s.name)).toEqual(["forge MainnetBeta.verifyDeploymentStrict", "verify:deployment --strict"]);
    expect(steps[0]!.cmd).toEqual(["forge", "script", "script/MainnetBeta.s.sol:MainnetBeta", "--sig", "verifyDeploymentStrict(string)", "4663.json", "--rpc-url", RPC]);
    expect(steps[0]!.cmd).not.toContain("--broadcast");
    expect(steps[0]!.cwd.endsWith("/contracts")).toBe(true);
    expect(steps[1]!.cmd).toEqual(["bun", "scripts/verify-deployment.ts", "--strict", "--file", "deployments/4663.json", "--rpc", RPC]);
  });

  test("the v1 file runs only verify:deployment --strict, and says why", () => {
    const { steps, notes } = gatePlan("4663.json", v1, RPC);
    expect(steps.map((s) => s.name)).toEqual(["verify:deployment --strict"]);
    expect(notes[0]).toContain("v1");
  });

  test("the file must be a plain name inside app/deployments (as MainnetBeta.checkOutName)", () => {
    for (const ok of ["4663.json", "fork.json", "dryrun-4663-beta.json"]) expect(isPlainName(ok)).toBe(true);
    for (const bad of ["../4663.json", "deployments/4663.json", ".hidden", "", "a b.json"]) expect(() => gatePlan(bad, v2, RPC)).toThrow();
  });
});
