// The desks use hand-written ABI subsets; every function and error they name must exist, with the same
// selector, in the compiled contracts.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector, type Abi, type AbiFunction, type AbiError } from "viem";
import { accountAbi, beaconAbi, cashSleeveAbi, equitySleeveAbi, errorsAbi, guardAbi, policyAbi, valuerAbi } from "../desks/abi";

const OUT = join(import.meta.dir, "..", "..", "..", "contracts", "out");
const art = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).abi as Abi;

let ready = false;
beforeAll(() => {
  if (!existsSync(join(OUT, "EquitySleeve.sol"))) {
    const forge = Bun.which("forge");
    if (forge) Bun.spawnSync([forge, "build", "--root", join(OUT, "..")], { stdout: "ignore", stderr: "ignore" });
  }
  ready = existsSync(join(OUT, "EquitySleeve.sol"));
});

const errSel = (e: AbiError) => toFunctionSelector({ ...e, type: "function", outputs: [], stateMutability: "nonpayable" } as AbiFunction);

function selectors(abi: Abi) {
  const s = new Set<string>();
  for (const i of abi) {
    if (i.type === "function") s.add(toFunctionSelector(i as AbiFunction));
    if (i.type === "error") s.add(errSel(i as AbiError));
  }
  return s;
}

function expectSubset(mine: Abi, theirs: Abi[]) {
  const all = new Set<string>();
  for (const t of theirs) for (const x of selectors(t)) all.add(x);
  for (const i of mine) {
    if (i.type !== "function") continue;
    const sel = toFunctionSelector(i as AbiFunction);
    expect(all.has(sel), `${(i as AbiFunction).name} ${sel}`).toBe(true);
  }
}

describe("hand-written ABIs match contracts/out", () => {
  test("functions", () => {
    if (!ready) return;
    expectSubset(accountAbi as Abi, [art("TreasuryAccount.sol", "TreasuryAccount")]);
    expectSubset(guardAbi as Abi, [art("PolicyGuard.sol", "PolicyGuard")]);
    expectSubset(policyAbi as Abi, [art("TreasuryPolicy.sol", "TreasuryPolicy")]);
    expectSubset(equitySleeveAbi as Abi, [art("EquitySleeve.sol", "EquitySleeve")]);
    expectSubset(cashSleeveAbi as Abi, [art("CashSleeve.sol", "CashSleeve")]);
    expectSubset(valuerAbi as Abi, [art("Valuer.sol", "Valuer")]);
    expectSubset(beaconAbi as Abi, [art("JitterBeacon.sol", "JitterBeacon")]);
  });

  test("every error the desks decode exists in some contract", () => {
    if (!ready) return;
    const all = new Set<string>();
    for (const [f, n] of [
      ["TreasuryAccount.sol", "TreasuryAccount"],
      ["CashSleeve.sol", "CashSleeve"],
      ["EquitySleeve.sol", "EquitySleeve"],
      ["StockRouter.sol", "StockRouter"],
      ["Valuer.sol", "Valuer"],
      ["JitterBeacon.sol", "JitterBeacon"],
      ["ERC4626.sol", "ERC4626"],
      ["SafeERC20.sol", "SafeERC20"],
    ] as const) {
      for (const s of selectors(art(f, n))) all.add(s);
    }
    for (const e of errorsAbi) expect(all.has(errSel(e as AbiError)), (e as AbiError).name).toBe(true);
  });
});
