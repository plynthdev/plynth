// The post-deploy check fails closed: a wrong chain, an owner left with the deployer, a pending hand-over or an
// unreadable contract is a FAIL, never an ok. No chain needed: the reader is a stub.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zeroAddress, type Address } from "viem";
import { verifyDeployment, type Deployment, type Reader } from "./verify-deployment";

const dep = JSON.parse(readFileSync(join(import.meta.dir, "..", "deployments", "4663.json"), "utf8")) as Deployment;
const hasCode = async () => true;
const fails = (checks: { status: string; what: string }[], what: RegExp) =>
  checks.filter((c) => c.status === "FAIL" && what.test(c.what));

/** Answers owner() / pendingOwner() / keeper() as given, and throws on everything else. */
const stub = (owner: Address, pending: Address): Reader => async (_a, sig) => {
  if (sig.includes(" owner()")) return owner;
  if (sig.includes("pendingOwner()")) return pending;
  if (sig.includes("keeper()")) return dep.keeper;
  throw new Error("not stubbed");
};

describe("verifyDeployment", () => {
  test("a wrong chain id fails", async () => {
    const checks = await verifyDeployment(dep, stub(dep.owner, zeroAddress), hasCode, 46630);
    expect(fails(checks, /^chain id$/)).toHaveLength(1);
  });

  test("an admin role still with the deployer fails on every contract", async () => {
    const checks = await verifyDeployment(dep, stub(dep.deployer, dep.owner), hasCode, dep.chainId);
    expect(fails(checks, /\.owner\(\) == OWNER$/).length).toBeGreaterThanOrEqual(13);
    expect(fails(checks, /pendingOwner\(\) == 0/).length).toBeGreaterThanOrEqual(11);
  });

  test("correct owners pass those checks", async () => {
    const checks = await verifyDeployment(dep, stub(dep.owner, zeroAddress), hasCode, dep.chainId);
    expect(fails(checks, /owner\(\)|pendingOwner\(\)|keeper\(\)/)).toHaveLength(0);
    expect(checks.filter((c) => c.status === "ok" && /\.owner\(\) == OWNER$/.test(c.what)).length).toBeGreaterThanOrEqual(13);
  });

  test("unreadable values and missing code are failures, not passes", async () => {
    const checks = await verifyDeployment(dep, stub(dep.owner, zeroAddress), async () => false, dep.chainId);
    expect(fails(checks, /: code$/).length).toBeGreaterThanOrEqual(19);
    expect(fails(checks, /valuer\.maxStaleness|crowdBuy\.WINDOW|registry entry|stock checks/).length).toBeGreaterThan(0);
    expect(checks.some((c) => c.status === "ok" && /maxStaleness|WINDOW|GRACE|CAP_DELAY/.test(c.what))).toBe(false);
  });
});
