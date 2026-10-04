import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stockTokens } from "@plynth/chain";
import { compileFile } from "@plynth/policy-compiler";
import { getAddress } from "viem";
import { parseConfig } from "../desks/config";
import { decodeRejection, GUARD_CODES } from "../desks/errors";
import { packProofs } from "../desks/runner";

const ROOT = join(import.meta.dir, "..", "..", "..");
const A = "0x00000000000000000000000000000000000000a1";
const base = { account: A, cashSleeve: A, equitySleeve: A, vault: A, beacon: A };

describe("desk config", () => {
  test("proofs come from the board's template and match the compiled allow root", () => {
    const c = parseConfig({ ...base, policyTemplate: join(ROOT, "templates", "balanced.yaml") }, ROOT);
    const compiled = compileFile(join(ROOT, "templates", "balanced.yaml"), { controller: A });
    expect(c.allowRoot).toBe(compiled.policy.instrumentAllowRoot);
    expect(c.proofs[getAddress(stockTokens.AAPL)]).toEqual(compiled.instruments.find((i) => i.label === "AAPL")!.proof);
    expect(c.cash).toEqual({ reserveBps: 200, sweepMinBps: 50 });
    expect(c.cashDeskId).toBe("cash");
  });

  test("board-supplied weights in the template's desks metadata resolve by symbol; config values win", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-cfg-"));
    writeFileSync(join(dir, "p.yaml"), `extends: ${join(ROOT, "templates", "balanced.yaml")}\ndesks:\n  equity:\n    targetBps: 5000\n    weights: { SPY: 3, AAPL: 1 }\n`);
    const c = parseConfig({ ...base, policyTemplate: "p.yaml" }, dir);
    expect(c.equity.targetBps).toBe(5000);
    expect(c.equity.weights).toEqual({ [getAddress(stockTokens.SPY)]: 3, [getAddress(stockTokens.AAPL)]: 1 });
    const o = parseConfig({ ...base, policyTemplate: "p.yaml", equity: { targetBps: 4000 } }, dir);
    expect(o.equity.targetBps).toBe(4000);
  });

  test("unknown weight symbol and missing fields are errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "plynth-cfg-"));
    writeFileSync(join(dir, "p.yaml"), `extends: ${join(ROOT, "templates", "balanced.yaml")}\ndesks:\n  equity:\n    weights: { QCOM: 1 }\n`);
    expect(() => parseConfig({ ...base, policyTemplate: "p.yaml" }, dir)).toThrow("unknown instrument QCOM");
    expect(() => parseConfig({ ...base, beacon: "", policyTemplate: "p.yaml" } as never, dir)).toThrow("beacon");
  });
});

describe("encoding and reason codes", () => {
  test("allowProof packing is [len, ...proof] per increased asset", () => {
    const h = `0x${"11".repeat(32)}` as const;
    expect(packProofs([[h, h], []])).toEqual([`0x${"0".repeat(63)}2`, h, h, `0x${"0".repeat(64)}`]);
  });
  test("every PolicyGuard reason code has a name", () => {
    for (let c = 1; c <= 11; c++) expect(GUARD_CODES[c]).toBeDefined();
  });
  test("non-viem errors decode to a reason with no code", () => {
    expect(decodeRejection(new Error("boom"))).toEqual({ code: null, reason: "boom" });
  });
});
