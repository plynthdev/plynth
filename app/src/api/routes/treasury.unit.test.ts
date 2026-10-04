// Fast treasury API checks: hand-written ABI subsets match the compiled contracts, template input handling,
// policy encoding, and error mapping without a chain.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction, type Address } from "viem";
import {
  BlockTimes,
  compileInput,
  createApp,
  encodePolicy,
  factoryAbi,
  tAccountAbi,
  tCloseAbi,
  templateNames,
  templates,
  tGuardAbi,
  tPolicyAbi,
  TxInputError,
  type ApiDeployment,
  type Deps,
} from "@/api";

const OUT = join(import.meta.dir, "..", "..", "..", "..", "contracts", "out");
const art = (file: string) => JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${file}.json`), "utf8")).abi as Abi;
let ready = false;
beforeAll(() => {
  if (!existsSync(join(OUT, "TreasuryFactory.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(OUT, "..")], { stdout: "ignore", stderr: "ignore" });
  }
  ready = existsSync(join(OUT, "TreasuryFactory.sol"));
});

function expectSubset(mine: Abi, file: string) {
  const theirs = art(file);
  const fns = new Set(theirs.filter((i) => i.type === "function").map((i) => toFunctionSelector(i as AbiFunction)));
  const evs = new Set(theirs.filter((i) => i.type === "event").map((i) => toEventSelector(i as AbiEvent)));
  for (const i of mine) {
    if (i.type === "function") expect(fns.has(toFunctionSelector(i as AbiFunction)), `${file}.${(i as AbiFunction).name}`).toBe(true);
    if (i.type === "event") expect(evs.has(toEventSelector(i as AbiEvent)), `${file} event ${(i as AbiEvent).name}`).toBe(true);
  }
}

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const tpl = {
  name: "unit",
  bands: { cash: [40, 70], equity: [30, 60] },
  limits: { perOrderUsd: 100000, perDayUsd: 500000, approvalAboveUsd: 50000, perNameFloatBps: 100 },
  risk: { noNewRiskOffHours: true, pauseNewRiskAtDrawdownBps: -400, deriskAtDrawdownBps: -800 },
  periodDays: 30,
  instruments: [{ asset: A(0x51), kind: "cash" }],
};

describe("treasury ABI subsets", () => {
  test("every function and event the API names exists in contracts/out", () => {
    if (!ready) return;
    expectSubset(factoryAbi, "TreasuryFactory");
    expectSubset(tAccountAbi, "TreasuryAccount");
    expectSubset(tPolicyAbi, "TreasuryPolicy");
    expectSubset(tGuardAbi, "PolicyGuard");
    expectSubset(tCloseAbi, "PeriodClose");
  });
});

describe("templates and policy encoding", () => {
  test("named templates are the files in templates/", () => {
    expect(templateNames()).toEqual(["balanced", "carry", "conservative"]);
    expect(templates().every((t) => t.tier === "T1" || t.tier === "T2")).toBe(true);
  });

  test("inline template compiles; encoding is the 21-word abi.encode(Policy) the factory requires", () => {
    const c = compileInput(31337, { template: tpl, controller: A(0xc0de) });
    expect(c.network).toBe("testnet");
    const enc = encodePolicy(c.policy);
    expect((enc.length - 2) / 2).toBe(21 * 32);
  });

  test("named mainnet template on chain 4663 resolves real addresses", () => {
    const c = compileInput(4663, { templateName: "balanced", controller: A(0xc0de) });
    expect(c.network).toBe("mainnet");
    expect(c.instruments.length).toBeGreaterThan(2);
  });

  test("bad input is a TxInputError (400), never a crash", () => {
    expect(() => compileInput(31337, { templateName: "../etc/passwd", controller: A(1) })).toThrow(TxInputError);
    expect(() => compileInput(31337, { templateName: "nope", controller: A(1) })).toThrow(TxInputError);
    expect(() => compileInput(31337, { template: { ...tpl, bands: { cash: [80, 20], equity: [0, 100] } }, controller: A(1) })).toThrow(TxInputError);
    expect(() => compileInput(31337, { template: { ...tpl, extends: "balanced" }, controller: A(1) })).toThrow(TxInputError);
    expect(() => compileInput(31337, { controller: A(1) })).toThrow(TxInputError);
  });
});

describe("routing without a chain", () => {
  const dep: ApiDeployment = { vault: A(1), crowd: A(2), beacon: A(3), valuer: A(4), usdg: A(5), stocks: [], deployBlock: 0n };
  const noChain = new Proxy({}, { get: () => () => Promise.reject(new Error("no chain in unit tests")) }) as any;
  const deps: Deps = { chainId: 31337, pub: noChain, db: noChain, dep, blockTimes: new BlockTimes(noChain) };
  const app = createApp(deps);

  test("treasury.create without a factory on the deployment is a 404", async () => {
    const r = await app.request("/v1/treasury/create", { method: "POST", body: JSON.stringify({ template: tpl, controller: A(9), board: A(8) }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(404);
  });

  test("account reads on an unreadable address are 404, bad input is 400", async () => {
    expect((await app.request(`/v1/treasury/${A(7)}/nav`)).status).toBe(404);
    expect((await app.request(`/v1/treasury/not-an-address/nav`)).status).toBe(400);
    expect((await app.request(`/v1/treasury/${A(7)}/actions?limit=0`)).status).toBe(400);
    expect((await app.request(`/v1/treasury/${A(7)}/cfo-pack/1?format=pdf`)).status).toBe(400);
    const both = await app.request(`/v1/treasury/${A(7)}/policy/diff`, { method: "POST", body: JSON.stringify({ templateName: "balanced", template: tpl, controller: A(9) }), headers: { "content-type": "application/json" } });
    expect(both.status).toBe(400);
  });

  test("the unsigned deploy tx decodes back to (policy bytes, board)", () => {
    const c = compileInput(31337, { template: tpl, controller: A(0xc0de) });
    const enc = encodePolicy(c.policy);
    const data = encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [enc, A(8)] });
    const d = decodeFunctionData({ abi: factoryAbi, data });
    expect(d.functionName).toBe("deploy");
    expect(d.args).toEqual([enc, A(8)]);
  });
});
