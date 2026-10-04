import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keccak256, toHex, type Hex } from "viem";
import { stockTokens } from "@/chain";
import {
  buildTree, compileFile, compileTemplate, diff, getProof, instrumentLeaf, loadTemplate, policyHash, summary,
  validate, verify, PolicyError, ZERO32, hashPair, venueLeaf, type Policy,
} from "./index";
import { FIXTURE_CONTROLLER, FIXTURE_PATH, REPO, TEMPLATES, fixtureText } from "./fixture";

const C = FIXTURE_CONTROLLER;
const tpl = (n: string) => join(REPO, "app", "templates", `${n}.yaml`);

describe("templates", () => {
  test("each template compiles, validates and every instrument proof verifies", () => {
    for (const name of TEMPLATES) {
      const c = compileFile(tpl(name), { controller: C });
      expect(c.name).toBe(name);
      validate(c.policy);
      expect(c.instruments.length).toBeGreaterThan(0);
      for (const i of c.instruments) {
        expect(i.leaf).toBe(instrumentLeaf(i.asset, i.kind));
        expect(verify(i.proof, c.policy.instrumentAllowRoot, i.leaf)).toBe(true);
      }
      expect(c.hash).toBe(policyHash(c.policy));
    }
  });

  test("conservative bands are cash 70-90, equity 10-30", () => {
    const p = compileFile(tpl("conservative"), { controller: C }).policy;
    expect(p.cash).toEqual({ minBps: 7000, maxBps: 9000 });
    expect(p.equity).toEqual({ minBps: 1000, maxBps: 3000 });
    expect(p.basis).toEqual({ minBps: 0, maxBps: 0 });
  });

  test("balanced bands are cash 40-70, equity 30-60", () => {
    const p = compileFile(tpl("balanced"), { controller: C }).policy;
    expect(p.cash).toEqual({ minBps: 4000, maxBps: 7000 });
    expect(p.equity).toEqual({ minBps: 3000, maxBps: 6000 });
  });

  test("carry equals balanced in T1 (same hash)", () => {
    const b = compileFile(tpl("balanced"), { controller: C });
    const c = compileFile(tpl("carry"), { controller: C });
    expect(c.name).toBe("carry");
    expect(c.hash).toBe(b.hash);
    expect(diff(b, c)).toBe("No changes.");
  });

  test("T1 fields are zero in every template", () => {
    for (const name of TEMPLATES) {
      const p = compileFile(tpl(name), { controller: C }).policy;
      expect([p.netDeltaMinBps, p.netDeltaMaxBps, p.maxLeverageX10, p.perVenueCapBps]).toEqual([0, 0, 0, 0]);
      expect(p.venueAllowRoot).toBe(ZERO32);
      expect(p.periodSeconds).toBe(30 * 86_400);
    }
  });

  test("instruments resolve to the verified Stock Token addresses", () => {
    const c = compileFile(tpl("balanced"), { controller: C });
    const tsla = c.instruments.find((i) => i.label === "TSLA")!;
    expect(tsla.asset).toBe(stockTokens.TSLA);
    expect(tsla.kind).toBe(2);
    expect(c.instruments.find((i) => i.label === "QCOM")).toBeUndefined();
  });

  test("controller is required", () => {
    expect(() => compileFile(tpl("balanced"))).toThrow(PolicyError);
  });

  test("Stock Tokens are rejected on testnet", () => {
    expect(() => compileFile(tpl("balanced"), { controller: C, network: "testnet" })).toThrow(/does not exist on testnet|mainnet only/);
    const base = loadTemplate(tpl("conservative"));
    expect(() => compileTemplate({ ...base, instruments: [{ asset: "SPY", kind: "stock_token" }] }, { controller: C, network: "testnet" })).toThrow(/mainnet only/);
  });

  test("the committed forge fixture is up to date", () => {
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(fixtureText());
  });
});

describe("template loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "plynth-policy-"));
  test("extends merges top-level keys and detects cycles", () => {
    writeFileSync(join(dir, "a.yaml"), readFileSync(tpl("balanced"), "utf8"));
    writeFileSync(join(dir, "b.yaml"), "extends: a\nname: b\nperiodDays: 7\n");
    const t = loadTemplate(join(dir, "b.yaml"));
    expect(t.name).toBe("b");
    expect(t.periodDays).toBe(7);
    expect(t.bands.cash).toEqual([40, 70]);
    writeFileSync(join(dir, "x.yaml"), "extends: y\nname: x\n");
    writeFileSync(join(dir, "y.yaml"), "extends: x\nname: y\n");
    expect(() => loadTemplate(join(dir, "x.yaml"))).toThrow(/cycle/);
  });

  test("duplicate instruments, unknown assets, venues and fractional bps are rejected", () => {
    const base = loadTemplate(tpl("conservative"));
    expect(() => compileTemplate({ ...base, instruments: [...base.instruments, base.instruments[0]!] }, { controller: C })).toThrow(/duplicate/);
    expect(() => compileTemplate({ ...base, instruments: [{ asset: "NOPE", kind: "cash" }] }, { controller: C })).toThrow(/unknown asset/);
    expect(() => compileTemplate({ ...base, venues: ["0x00000000000000000000000000000000000000aa"] }, { controller: C })).toThrow(/T1Venue/);
    expect(() => compileTemplate({ ...base, venues: [{}] as never }, { controller: C })).toThrow(/BadVenue/);
    expect(() => compileTemplate({ ...base, bands: { cash: [70.001, 90], equity: [10, 30] } }, { controller: C })).toThrow(/whole bps/);
  });

  test("an invalid template fails with the Solidity error name", () => {
    const base = loadTemplate(tpl("conservative"));
    const bad = (patch: object) => () => compileTemplate({ ...base, ...patch }, { controller: C });
    expect(bad({ bands: { cash: [80, 90], equity: [30, 40] } })).toThrow(/BadBandSums/);
    expect(bad({ bands: { cash: [70, 90], equity: [10, 30], basis: [0, 5] } })).toThrow(/T1Basis/);
    expect(bad({ hedge: { maxLeverageX10: 10 } })).toThrow(/BadVenueCap/); // leverage switches to T2 rules
    expect(bad({ hedge: { maxLeverageX10: 40 } })).toThrow(/LeverageTooHigh/);
    expect(bad({ risk: { noNewRiskOffHours: true, pauseNewRiskAtDrawdownBps: -600, deriskAtDrawdownBps: -300 } })).toThrow(/BadDrawdown/);
    expect(bad({ periodDays: 0.5 })).toThrow(/BadPeriod/);
    expect(bad({ limits: { ...base.limits, perNameFloatBps: 201 } })).toThrow(/FloatCapTooHigh/);
  });
});

describe("validate mirrors TreasuryPolicy.validate", () => {
  const good = (): Policy => compileFile(tpl("conservative"), { controller: C }).policy;
  const code = (p: Policy) => {
    try { validate(p); return "ok"; } catch (e) { return (e as PolicyError).code; }
  };

  test("named rules", () => {
    expect(code(good())).toBe("ok");
    expect(code({ ...good(), equity: { minBps: 3001, maxBps: 3000 } })).toBe("BadBand");
    expect(code({ ...good(), cash: { minBps: 7000, maxBps: 10_001 } })).toBe("BadBand");
    expect(code({ ...good(), netDeltaMaxBps: 1 })).toBe("T1NetDelta");
    expect(code({ ...good(), perVenueCapBps: 1 })).toBe("T1Venue");
    expect(code({ ...good(), venueAllowRoot: `0x${"0".repeat(63)}1` })).toBe("T1Venue");
    expect(code({ ...good(), pauseNewRiskAtDrawdownBps: 0 })).toBe("ok");
    expect(code({ ...good(), pauseNewRiskAtDrawdownBps: 1 })).toBe("BadDrawdown");
    expect(code({ ...good(), periodSeconds: 86_399 })).toBe("BadPeriod");
    expect(code({ ...good(), controller: "0x0000000000000000000000000000000000000000" })).toBe("ZeroAddress");
  });

  test("T2 rules (leverage set)", () => {
    const t2 = (): Policy => ({ ...good(), cash: { minBps: 5000, maxBps: 8000 }, basis: { minBps: 0, maxBps: 2000 }, netDeltaMinBps: -500, netDeltaMaxBps: 2500, maxLeverageX10: 30, perVenueCapBps: 2000, venueAllowRoot: `0x${"0".repeat(63)}1` });
    expect(code(t2())).toBe("ok");
    expect(code({ ...t2(), maxLeverageX10: 31 })).toBe("LeverageTooHigh");
    expect(code({ ...t2(), netDeltaMinBps: 100, netDeltaMaxBps: 50 })).toBe("BadNetDelta");
    expect(code({ ...t2(), netDeltaMinBps: -10_001 })).toBe("BadNetDelta");
    expect(code({ ...t2(), perVenueCapBps: 0 })).toBe("BadVenueCap");
    expect(code({ ...t2(), perVenueCapBps: 10_001 })).toBe("BadVenueCap");
    expect(code({ ...t2(), venueAllowRoot: ZERO32 })).toBe("NoVenues");
  });

  test("a T2 template compiles venues into venueAllowRoot with proofs", () => {
    const base = loadTemplate(tpl("balanced"));
    const venues = ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"];
    const c = compileTemplate(
      { ...base, bands: { cash: [40, 70], equity: [30, 60], basis: [0, 10] }, hedge: { netDeltaBps: [1000, 4500], maxLeverageX10: 30 }, limits: { ...base.limits, perVenueBps: 2000 }, venues },
      { controller: C },
    );
    expect(c.policy.maxLeverageX10).toBe(30);
    expect(c.venues.length).toBe(2);
    expect(c.venues[0]!.leaf).toBe(venueLeaf(venues[0] as `0x${string}`));
    expect(c.policy.venueAllowRoot).toBe(hashPair(c.venues[0]!.leaf, c.venues[1]!.leaf));
    expect(c.venues[0]!.proof).toEqual([c.venues[1]!.leaf]);
  });

  test("fuzz: band rules match the reference model", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let k = 0; k < 2000; k++) {
      const [cMin, cMax, eMin, eMax] = [rnd(10_500), rnd(10_500), rnd(10_500), rnd(10_500)];
      const p = { ...good(), cash: { minBps: cMin, maxBps: cMax }, equity: { minBps: eMin, maxBps: eMax } };
      const bandsOk = cMin <= cMax && cMax <= 10_000 && eMin <= eMax && eMax <= 10_000;
      const sumsOk = cMin + eMin <= 10_000 && cMax + eMax >= 10_000;
      expect(code(p)).toBe(!bandsOk ? "BadBand" : !sumsOk ? "BadBandSums" : "ok");
    }
  });
});

describe("merkle", () => {
  const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => keccak256(toHex(`leaf-${i}`)));

  test("every leaf verifies for tree sizes 1..33, and a foreign leaf does not", () => {
    for (let n = 1; n <= 33; n++) {
      const ls = leaves(n);
      const t = buildTree(ls);
      for (const l of ls) expect(verify(getProof(t, l), t.root, l)).toBe(true);
      expect(verify(getProof(t, ls[0]!), t.root, keccak256(toHex("other")))).toBe(false);
    }
  });

  test("single leaf: root is the leaf and the proof is empty", () => {
    const [l] = leaves(1);
    const t = buildTree([l!]);
    expect(t.root).toBe(l!);
    expect(getProof(t, l!)).toEqual([]);
  });

  test("root does not depend on input order", () => {
    const ls = leaves(9);
    expect(buildTree([...ls].reverse()).root).toBe(buildTree(ls).root);
  });

  test("empty tree has a zero root", () => {
    expect(buildTree([]).root).toBe(ZERO32);
  });
});

describe("text", () => {
  test("summary lists bands, caps and instruments", () => {
    const s = summary(compileFile(tpl("conservative"), { controller: C }));
    expect(s).toContain("Cash: 70% to 90% of NAV");
    expect(s).toContain("Per-order cap: $50,000");
    expect(s).toContain("SPY (stock token)");
    expect(s).toContain("De-risk at drawdown: -6%");
  });

  test("diff shows changed rules and added/removed instruments", () => {
    const a = compileFile(tpl("conservative"), { controller: C });
    const b = compileFile(tpl("balanced"), { controller: C });
    const d = diff(a, b);
    expect(d).toContain("~ Cash: 70% to 90% of NAV -> 40% to 70% of NAV");
    expect(d).toContain("+ instrument NVDA (stock token)");
    expect(d).not.toContain("Period");
    expect(diff(b, a)).toContain("- instrument TSLA (stock token)");
  });
});
