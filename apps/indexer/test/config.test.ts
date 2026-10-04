import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEventSelector, type AbiEvent } from "viem";
import { DEPLOYMENT_EVENTS, loadStreams, spendStreams, STOCK_TOKEN_EVENTS } from "../src/config";
import { toJsonSafe } from "../src/json";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function depDir(dep: object) {
  const dir = mkdtempSync(join(tmpdir(), "plynth-dep-"));
  writeFileSync(join(dir, "46630.json"), JSON.stringify(dep));
  return dir;
}

describe("config", () => {
  test("streams come from deployments/<chainid>.json, fromBlock = deployBlock", () => {
    const dir = depDir({ chainId: 46630, deployBlock: 1234, usdg: A(1), stockTokenRegistry: A(2), stockRouter: A(3), jitterBeacon: A(4), valuer: A(5), stocks: { mTSLA: { token: A(6) } } });
    const s = loadStreams({ chain: "testnet", chainId: 46630, deploymentsDir: dir });
    expect(s.map((x) => x.name)).toEqual(["46630:stockTokenRegistry", "46630:stockRouter", "46630:jitterBeacon", "46630:stock:mTSLA"]);
    expect(s.every((x) => x.fromBlock === 1234n)).toBe(true);
    expect(s[3]!.events).toBe(STOCK_TOKEN_EVENTS);
  });

  test("static list: USDG Transfer in/out per linked wallet, deployment usdg wins", () => {
    const dir = depDir({ chainId: 46630, usdg: A(1) });
    const s = loadStreams({ chain: "testnet", chainId: 46630, deploymentsDir: dir, wallets: [A(9)], fromBlock: 7n });
    expect(s.map((x) => x.name)).toEqual(["46630:usdg:in", "46630:usdg:out"]);
    expect(s[0]!.args).toEqual({ to: [A(9)] });
    expect(s[1]!.args).toEqual({ from: [A(9)] });
    expect(s[0]!.address.toLowerCase()).toBe(A(1));
    expect(s[0]!.fromBlock).toBe(7n);
  });

  test("without a deployment file, mainnet wallets use the verified USDG address; no wallets = no streams", () => {
    expect(loadStreams({ chain: "mainnet", chainId: 4663, deploymentsDir: "/nonexistent" })).toEqual([]);
    const s = loadStreams({ chain: "mainnet", chainId: 4663, wallets: [A(9)] });
    expect(s[0]!.address).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  });

  test("extra streams parse human-readable events; duplicates and multi-event args filters are rejected", () => {
    const s = loadStreams({ chain: "local", chainId: 31337, extra: [{ name: "emitter", address: A(5), events: ["event Ping(uint256 indexed n)"], fromBlock: 3 }] });
    expect(s[0]!.events[0]!.name).toBe("Ping");
    expect(s[0]!.fromBlock).toBe(3n);
    const dup = { name: "e", address: A(5), events: ["event Ping(uint256 indexed n)"] };
    expect(() => loadStreams({ chain: "local", chainId: 1, extra: [dup, dup] })).toThrow(/duplicate/);
    expect(() =>
      loadStreams({ chain: "local", chainId: 1, extra: [{ ...dup, events: ["event A(uint256 indexed n)", "event B(uint256 indexed n)"], args: { n: 1 } }] }),
    ).toThrow(/exactly one event/);
  });

  test("event signatures match the compiled contracts (skips if contracts/out is not built)", () => {
    const out = join(import.meta.dir, "..", "..", "..", "contracts", "out");
    const map: Record<string, string> = {
      stockTokenRegistry: "StockTokenRegistry",
      stockRouter: "StockRouter",
      jitterBeacon: "JitterBeacon",
      savingsVault: "SavingsVault",
      crowdBuy: "CrowdBuy",
    };
    const check = (contract: string, events: AbiEvent[]) => {
      const f = join(out, `${contract}.sol`, `${contract}.json`);
      if (!existsSync(f)) return console.warn(`skip: ${f} not built`);
      const abi = JSON.parse(readFileSync(f, "utf8")).abi.filter((x: any) => x.type === "event");
      const compiled = new Set(abi.map((e: any) => toEventSelector(e)));
      for (const e of events) expect(compiled.has(toEventSelector(e))).toBe(true);
    };
    for (const [k, c] of Object.entries(map)) check(c, DEPLOYMENT_EVENTS[k]!);
    check("MockStockToken", STOCK_TOKEN_EVENTS);
  });

  test("spend streams: one USDG Transfer(from = wallet) stream per linked wallet from its link block", () => {
    const s = spendStreams(46630, "testnet", A(1), [{ wallet: A(9), fromBlock: 42n }]);
    expect(s).toHaveLength(1);
    expect(s[0]!.name).toBe(`46630:usdg:spend:${A(9)}`);
    expect(s[0]!.args).toEqual({ from: A(9) });
    expect(s[0]!.fromBlock).toBe(42n);
    expect(s[0]!.events[0]!.name).toBe("Transfer");
  });

  test("toJsonSafe turns bigint into decimal strings, deeply", () => {
    expect(toJsonSafe({ a: 2n ** 200n, b: [1n, { c: -5n }], d: "x", e: null })).toEqual({ a: (2n ** 200n).toString(), b: ["1", { c: "-5" }], d: "x", e: null });
  });
});
