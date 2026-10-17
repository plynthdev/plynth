// The bytecode comparison masks only immutables and library slots: any other byte difference is a mismatch.
// Every Plynth contract in a deployment file is a verification target, with constructor arguments rebuilt the way
// MainnetBeta.s.sol passes them; a parameter nobody mapped falls back to guessing and says so.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeAbiParameters, encodeAbiParameters, getAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  argsFromCreation, constructorArgs, CONSTRUCTOR, creationInputs, DISCOVERED, masked, NOT_PLYNTH, PERP_MARKET, shape, SOURCES, targetsOf, verifyCommand, zeroOf,
  type Param, type Target,
} from "./verify-explorer";
import { V2, type Deployment } from "./verify-deployment";

const v1 = JSON.parse(readFileSync(join(import.meta.dir, "..", "deployments", "4663-v1.json"), "utf8")) as Deployment;
const v2 = { ...v1, allowEoaOwner: false, calendarValidUntil: Number(V2.calendarValidUntil) } as Deployment;
const CONTRACTS = join(import.meta.dir, "..", "..", "contracts");
const fake = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const discovered: Record<string, Address> = Object.fromEntries(DISCOVERED.map(([o, g], i) => [`${o}.${g}`, fake(0xd00 + i)]));
const t = (name: string, id: string): Target => ({ name, address: fake(1), id, libraries: [] });

/** Constructor parameter names of a contract, read from its source (no build needed). */
function ctorParams(id: string): string[] | undefined {
  const [path, name] = id.split(":") as [string, string];
  const src = readFileSync(join(CONTRACTS, path), "utf8");
  const body = src.slice(src.search(new RegExp(`^contract ${name}\\b`, "m")));
  const m = body.slice(0, body.indexOf("\n}\n") + 2).match(/constructor\(([^)]*)\)/);
  if (!m) return undefined;
  return m[1]!.split(",").map((p) => p.trim().split(/\s+/).pop()!).filter(Boolean);
}

describe("verify-explorer", () => {
  test("masking zeroes exactly the given ranges", () => {
    expect(masked("0x11223344556677", [{ start: 1, length: 2 }])).toBe("11000044556677");
    expect(masked("0xaabb", [])).toBe("aabb");
  });

  test("an immutable difference is ignored, a code difference is not", () => {
    const refs = [{ start: 2, length: 2 }];
    expect(masked("0x6080beef00", refs)).toBe(masked("0x6080000000", refs));
    expect(masked("0x6081beef00", refs)).not.toBe(masked("0x6080000000", refs));
  });

  test("every source id names a contract file under src/", () => {
    for (const id of [...Object.values(SOURCES), PERP_MARKET, ...DISCOVERED.map((d) => d[2])]) expect(id).toMatch(/^src\/[\w/]+\.sol:\w+$/);
  });
});

describe("targets", () => {
  test("every address in the v1 and v2 files is a target or a known non-Plynth address", () => {
    for (const dep of [v1, v2]) {
      const { targets, unmapped } = targetsOf(dep);
      expect(unmapped).toEqual([]);
      expect(targets.length).toBe(19 + 4); // 19 contracts without the token + 4 perp markets
      expect(targets.filter((x) => x.id === PERP_MARKET).map((x) => x.name).sort()).toEqual(["perpMarket AAPL", "perpMarket NVDA", "perpMarket SPY", "perpMarket TSLA"]);
    }
  });

  test("an unknown contract key is reported, never silently skipped", () => {
    const { unmapped } = targetsOf({ ...v2, newThing: "0x00000000000000000000000000000000000000aa" });
    expect(unmapped).toEqual(["newThing"]);
  });

  test("the roles and chain contracts in the file are the non-Plynth set", () => {
    for (const k of ["deployer", "owner", "keeper", "attester", "relayer", "controller", "cashDesk", "equityDesk", "usdg", "steakUsdg"]) expect(NOT_PLYNTH.has(k)).toBe(true);
  });
});

describe("constructor arguments", () => {
  test("every constructor parameter of every deployed contract has a value (drift guard against the sources)", () => {
    const ids = [...Object.values(SOURCES), PERP_MARKET, ...DISCOVERED.map((d) => d[2])];
    for (const id of ids) {
      const name = id.split(":")[1]!;
      const params = ctorParams(id) ?? [];
      const table = CONSTRUCTOR[name];
      if (params.length === 0) continue; // the verifiers' leaf contracts pass fixed arguments to their base
      expect(table, name).toBeDefined();
      if (table === "*zero*") continue;
      for (const p of params) expect(Object.keys(table!), `${name}(${p})`).toContain(p);
    }
  });

  test("PerpPool and PerpMarket encode exactly what MainnetBeta passes", () => {
    const pp: Param[] = [{ name: "usdg", type: "address" }, { name: "owner_", type: "address" }, { name: "redeemCooldown_", type: "uint256" }, { name: "timelock_", type: "uint256" }];
    const r = constructorArgs(t("perpPool", SOURCES.perpPool!), pp, { dep: v2, discovered });
    expect("args" in r).toBe(true);
    const [usdg, owner, cooldown, timelock] = decodeAbiParameters(pp, (r as { args: Hex }).args);
    expect([usdg, owner, cooldown, timelock]).toEqual([getAddress(v2.usdg as string), getAddress(v2.deployer), 86_400n, 172_800n]);

    const pm: Param[] = [{ name: "pool_", type: "address" }, { name: "valuer_", type: "address" }, { name: "underlying_", type: "address" }, { name: "owner_", type: "address" }];
    const m = constructorArgs(t("perpMarket NVDA", PERP_MARKET), pm, { dep: v2, discovered }) as { args: Hex };
    expect(decodeAbiParameters(pm, m.args)[2]).toBe(getAddress(v2.stocks.NVDA!.token));
  });

  test("v1 and v2 use their own risk values (PolicyGuard loss bound 200 vs 50 bps)", () => {
    const pg: Param[] = [{ name: "registry_", type: "address" }, { name: "valuer_", type: "address" }, { name: "maxOpLossBps_", type: "uint16" }];
    const one = constructorArgs(t("policyGuard", SOURCES.policyGuard!), pg, { dep: v1, discovered }) as { args: Hex };
    const two = constructorArgs(t("policyGuard", SOURCES.policyGuard!), pg, { dep: v2, discovered }) as { args: Hex };
    expect(decodeAbiParameters(pg, one.args)[2]).toBe(200);
    expect(decodeAbiParameters(pg, two.args)[2]).toBe(50);
  });

  test("a v1 constructor without a v2 parameter still encodes (resolved by name)", () => {
    const v1PerpPool: Param[] = [{ name: "usdg", type: "address" }, { name: "owner_", type: "address" }, { name: "redeemCooldown_", type: "uint256" }];
    const r = constructorArgs(t("perpPool", SOURCES.perpPool!), v1PerpPool, { dep: v1, discovered }) as { args: Hex };
    expect((r.args.length - 2) / 2).toBe(96);
  });

  test("an unmapped parameter falls back to guessing, with the reason", () => {
    const r = constructorArgs(t("perpPool", SOURCES.perpPool!), [{ name: "somethingNew_", type: "uint256" }], { dep: v2, discovered });
    expect(r).toEqual({ note: "no value for PerpPool(somethingNew_)" });
    const cmd = verifyCommand({ ...t("perpPool", SOURCES.perpPool!), argsNote: "x" }, 4663, "sourcify", "", "http://rpc");
    expect(cmd).toContain("--guess-constructor-args");
  });

  test("no constructor means no --constructor-args; clone implementations are zeros (the policy keeps its timelock)", () => {
    expect(constructorArgs(t("receipts", SOURCES.receipts!), [], { dep: v2, discovered })).toEqual({ args: "0x" });
    const policy: Param[] = [
      { name: "board_", type: "address" },
      { name: "initial", type: "tuple", components: [{ name: "a", type: "uint64" }, { name: "b", type: "address[]" }, { name: "c", type: "bytes32" }] },
      { name: "timelock_", type: "uint64" },
    ];
    const r = constructorArgs(t("treasuryFactory.policyImpl", "src/treasury/TreasuryPolicy.sol:TreasuryPolicy"), policy, { dep: v2, discovered }) as { args: Hex };
    expect(r.args).toBe(encodeAbiParameters(policy, [zeroAddress, { a: 0n, b: [], c: `0x${"00".repeat(32)}` }, 172_800n]));
    const acct: Param[] = [{ name: "board_", type: "address" }, { name: "policy_", type: "address" }];
    const z = constructorArgs(t("treasuryFactory.accountImpl", "src/treasury/TreasuryAccount.sol:TreasuryAccount"), acct, { dep: v2, discovered }) as { args: Hex };
    expect(z.args).toBe(`0x${"00".repeat(64)}`);
  });

  test("EquitySleeve lists the stocks in MainnetBeta order, CashSleeve steakUSDG", () => {
    const es: Param[] = [{ name: "router_", type: "address" }, { name: "tokens", type: "address[]" }];
    const r = constructorArgs(t("equitySleeve", SOURCES.equitySleeve!), es, { dep: v1, discovered }) as { args: Hex };
    const tokens = decodeAbiParameters(es, r.args)[1] as Address[];
    expect(tokens).toEqual(V2.stocks.slice(0, 9).map(([, a]) => getAddress(a)));
  });

  test("tuples given positionally are shaped by component name", () => {
    const p: Param = { name: "t", type: "tuple[]", components: [{ name: "minStake", type: "uint256" }, { name: "tier", type: "tuple", components: [{ name: "maxDesks", type: "uint8" }, { name: "weeklyClose", type: "bool" }] }] };
    expect(shape(p, [[1n, [2, true]]])).toEqual([{ minStake: 1n, tier: { maxDesks: 2, weeklyClose: true } }]);
    expect(zeroOf({ name: "x", type: "uint8[2]" })).toEqual([0n, 0n]);
  });
});

describe("creation transaction cross-check", () => {
  test("the argument bytes are what follows the creation code", () => {
    const code = "0x6080604052" as Hex;
    const args = encodeAbiParameters([{ type: "uint256" }], [7n]);
    expect(argsFromCreation(`${code}${args.slice(2)}` as Hex, code)).toBe(args);
    expect(argsFromCreation(code, code)).toBe("0x");
  });

  test("forge's broadcast file maps each created address to its input", () => {
    const m = creationInputs({
      transactions: [
        { transactionType: "CREATE", contractAddress: "0x00000000000000000000000000000000000000Aa", transaction: { input: "0x01" } },
        { transactionType: "CALL", contractAddress: null, transaction: { input: "0x02" } },
      ],
    });
    expect([...m.entries()]).toEqual([["0x00000000000000000000000000000000000000aa", "0x01"]]);
  });
});

describe("commands", () => {
  test("mainnet uses Sourcify with explicit constructor args and libraries; nothing is guessed", () => {
    const cmd = verifyCommand({ ...t("valuer", SOURCES.valuer!), args: "0xabcd", libraries: ["src/L.sol:L:0x0000000000000000000000000000000000000001"] }, 4663, "sourcify", "https://b", "https://rpc");
    expect(cmd.slice(0, 3)).toEqual(["verify-contract", fake(1), SOURCES.valuer!]);
    expect(cmd).toEqual(expect.arrayContaining(["--verifier", "sourcify", "--chain", "4663", "--constructor-args", "0xabcd", "--libraries"]));
    expect(cmd).not.toContain("--guess-constructor-args");
    expect(cmd).not.toContain("blockscout");
  });

  test("a contract without constructor args gets no --constructor-args", () => {
    const cmd = verifyCommand({ ...t("receipts", SOURCES.receipts!), args: "0x" }, 4663, "sourcify", "", "");
    expect(cmd).not.toContain("--constructor-args");
  });

  test("the testnet keeps Blockscout", () => {
    const cmd = verifyCommand({ ...t("valuer", SOURCES.valuer!), args: "0x" }, 46630, "blockscout", "https://explorer", "");
    expect(cmd).toEqual(expect.arrayContaining(["--verifier", "blockscout", "--verifier-url", "https://explorer/api/"]));
  });
});

// keep the source scan honest: the drift guard must actually find constructors
test("the source scan finds constructors", () => {
  expect(ctorParams("src/perps/PerpPool.sol:PerpPool")).toEqual(["usdg", "owner_", "redeemCooldown_", "timelock_"]);
  expect(ctorParams("src/consumer/verifiers/TransferVerifier.sol:TransferVerifier")).toBeUndefined();
  expect(statSync(CONTRACTS).isDirectory() && readdirSync(CONTRACTS).includes("src")).toBe(true);
});
