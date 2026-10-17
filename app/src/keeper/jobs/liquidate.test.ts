// Job liquidate: the pure decision, per-account isolation over a fake chain, wiring and the ABI slice.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, toFunctionSelector, type Address } from "viem";
import { perpMarketKeeperAbi, perpPoolKeeperAbi } from "@/abi/keeper";
import { keeperDeployment, perpMarketsOf, type Ctx } from "@/keeper/context";
import { JOBS } from "@/keeper/keeper";
import { ROOT } from "@/testing/keeper-helpers";
import { liquidationAction, runLiquidate } from "./liquidate";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const KEEPER = A(0xbeef);
const POOL = A(0x900);
const M1 = A(0x901);
const M2 = A(0x902);

describe("liquidationAction mirrors PerpMarket.liquidate / settleHeld", () => {
  const base = { account: A(1), keeper: KEEPER, keeperIsOperator: false, liquidatable: false, settleable: false };
  test("healthy position on a live market: nothing", () => expect(liquidationAction(base).kind).toBe("none"));
  test("below maintenance: liquidate (bad debt too: the market pays a minimum reward)", () =>
    expect(liquidationAction({ ...base, liquidatable: true }).kind).toBe("liquidate"));
  test("market held past its grace: settle at the last price", () => expect(liquidationAction({ ...base, settleable: true }).kind).toBe("settle"));
  test("never the keeper's own position or one it operates (the market refuses both)", () => {
    expect(liquidationAction({ ...base, liquidatable: true, account: KEEPER.toLowerCase() as Address })).toMatchObject({ kind: "skip" });
    expect(liquidationAction({ ...base, liquidatable: true, keeperIsOperator: true })).toMatchObject({ kind: "skip", reason: expect.stringMatching(/operator/) });
  });
  test("settleHeld is open to anyone, the account's operator included", () =>
    expect(liquidationAction({ ...base, settleable: true, keeperIsOperator: true }).kind).toBe("settle"));
});

type Chain = {
  positions: Record<string, Address[]>;
  liquidatable: Set<string>;
  heldFor?: Record<string, bigint>;
  retireAt?: Record<string, bigint>;
  operatorOf?: Set<string>;
  throwOn?: Set<string>;
  revertOn?: Record<string, string>;
};

function fakeCtx(chain: Chain, markets: Address[]) {
  const sent: string[] = [];
  const key = (m: Address, a: unknown) => `${m}:${String(a)}`.toLowerCase();
  const pub = {
    getBlock: async () => ({ timestamp: 1_800_000_000n }),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
      if (functionName === "openPositionCount") return 0n; // the poke phase: nothing to poke here
      if (functionName === "openPositions") {
        if (chain.throwOn?.has(`${address}:list`.toLowerCase())) throw new Error("execution reverted");
        return chain.positions[address] ?? [];
      }
      if (functionName === "pool") return POOL;
      if (functionName === "heldFor") return chain.heldFor?.[address] ?? 0n;
      if (functionName === "HELD_GRACE") return 432_000n;
      if (functionName === "retireAt") return chain.retireAt?.[address] ?? 0n;
      if (functionName === "isOperator") return chain.operatorOf?.has(String(args[0]).toLowerCase()) ?? false;
      if (functionName === "isLiquidatable") {
        if (chain.throwOn?.has(key(address, args[0]))) throw new Error("rpc: connection reset\nstack");
        return chain.liquidatable.has(key(address, args[0]));
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async ({ address, args }: { address: Address; args: unknown[] }) => {
      const rev = chain.revertOn?.[key(address, args[0])];
      if (rev) {
        const { BaseError, ContractFunctionRevertedError } = await import("viem");
        const inner = new ContractFunctionRevertedError({ abi: perpMarketKeeperAbi as any, functionName: "liquidate", data: "0x" });
        (inner as any).data = { errorName: rev };
        throw new BaseError("reverted", { cause: inner });
      }
      return { result: undefined };
    },
  };
  const sender = {
    sendCall: async (to: Address, _abi: unknown, fn: string, args: unknown[]) => {
      sent.push(`${fn}:${to}:${String(args[0])}`.toLowerCase());
      return { transactionHash: "0x01" };
    },
  };
  const ctx = { account: KEEPER, pub, sender, dep: { perpMarkets: markets }, log: () => {} } as unknown as Ctx;
  return { ctx, sent };
}

describe("runLiquidate over a fake chain", () => {
  test("liquidates every liquidatable account; a throwing account does not stop the pass", async () => {
    const a1 = A(1), a2 = A(2), a3 = A(3);
    const { ctx, sent } = fakeCtx(
      {
        positions: { [M1]: [a1, a2, a3] },
        liquidatable: new Set([`${M1}:${a1}`.toLowerCase(), `${M1}:${a3}`.toLowerCase()]),
        throwOn: new Set([`${M1}:${a2}`.toLowerCase()]),
      },
      [M1],
    );
    const r = await runLiquidate(ctx);
    expect(sent).toEqual([`liquidate:${M1}:${a1}`.toLowerCase(), `liquidate:${M1}:${a3}`.toLowerCase()]);
    expect(r.actions).toBe(2);
    expect(r.ok).toBe(false); // the account it could not check is a failure /health shows
    expect(r.notes.join("|")).toMatch(new RegExp(`${a2}: failed \\(rpc: connection reset\\)`));
  });

  test("skips the keeper's own and operated accounts with a note; a raced NotLiquidatable is not a failure", async () => {
    const a1 = A(1), a2 = A(2);
    const { ctx, sent } = fakeCtx(
      {
        positions: { [M1]: [KEEPER, a1, a2] },
        liquidatable: new Set([KEEPER, a1, a2].map((a) => `${M1}:${a}`.toLowerCase())),
        operatorOf: new Set([a1.toLowerCase()]),
        revertOn: { [`${M1}:${a2}`.toLowerCase()]: "NotLiquidatable" },
      },
      [M1],
    );
    const r = await runLiquidate(ctx);
    expect(sent).toEqual([]);
    expect(r.notes.some((n) => n.includes(KEEPER) && /own position/.test(n))).toBe(true);
    expect(r.notes.some((n) => n.includes(a1) && /operator/.test(n))).toBe(true);
    expect(r.notes.some((n) => n.includes(a2) && /reverts NotLiquidatable/.test(n))).toBe(true);
    expect(r.ok).toBe(false); // two liquidatable positions stay open: someone else must close them
  });

  test("a market held past its grace: settleHeld every position; a broken market does not stop the next", async () => {
    const a1 = A(1), a2 = A(2);
    const { ctx, sent } = fakeCtx(
      { positions: { [M2]: [a1, a2] }, liquidatable: new Set(), heldFor: { [M2]: 432_001n }, throwOn: new Set([`${M1}:list`.toLowerCase()]) },
      [M1, M2],
    );
    const r = await runLiquidate(ctx);
    expect(sent).toEqual([`settleheld:${M2}:${a1}`.toLowerCase(), `settleheld:${M2}:${a2}`.toLowerCase()]);
    expect(r.notes.join("|")).toMatch(/cannot list positions/);
  });

  test("review v3 R3-PERP-5: a retired market past its notice: settleRetired every position; before it, nothing", async () => {
    const a1 = A(1), a2 = A(2);
    const due = fakeCtx({ positions: { [M1]: [a1, a2] }, liquidatable: new Set(), retireAt: { [M1]: 1_800_000_000n } }, [M1]);
    const r = await runLiquidate(due.ctx);
    expect(due.sent).toEqual([`settleretired:${M1}:${a1}`.toLowerCase(), `settleretired:${M1}:${a2}`.toLowerCase()]);
    expect(r.ok).toBe(true);
    const early = fakeCtx({ positions: { [M1]: [a1] }, liquidatable: new Set(), retireAt: { [M1]: 1_800_000_001n } }, [M1]);
    await runLiquidate(early.ctx);
    expect(early.sent).toEqual([]);
    // Market closed (Hold): a note, not a failure; the next open-market pass settles it.
    const held = fakeCtx(
      { positions: { [M1]: [a1] }, liquidatable: new Set(), retireAt: { [M1]: 1n }, revertOn: { [`${M1}:${a1}`.toLowerCase()]: "Hold" } },
      [M1],
    );
    const rh = await runLiquidate(held.ctx);
    expect(held.sent).toEqual([]);
    expect(rh.ok).toBe(true);
    expect(rh.notes.join("|")).toMatch(/settleRetired reverts Hold/);
  });

  test("liquidationAction: liquidation first, then the held settle, then the retired settle", () => {
    const base = { account: A(1), keeper: KEEPER, keeperIsOperator: false, liquidatable: false, settleable: false };
    expect(liquidationAction({ ...base, retiredDue: true }).kind).toBe("settleRetired");
    expect(liquidationAction({ ...base, retiredDue: true, settleable: true }).kind).toBe("settle");
    expect(liquidationAction({ ...base, retiredDue: true, liquidatable: true }).kind).toBe("liquidate");
  });

  test("healthy book or no markets: nothing sent, ok", async () => {
    const { ctx, sent } = fakeCtx({ positions: { [M1]: [A(1)] }, liquidatable: new Set() }, [M1]);
    expect((await runLiquidate(ctx)).ok).toBe(true);
    expect(sent).toEqual([]);
    const empty = fakeCtx({ positions: {}, liquidatable: new Set() }, []);
    expect((await runLiquidate(empty.ctx)).notes).toEqual(["no perp markets in the deployment"]);
  });
});

describe("wiring", () => {
  test("liquidate is a safety job: right after the mock-feed refresh, before every consumer job", () => {
    const names = JOBS.map(([n]) => n);
    expect(names[0]).toBe("refresh-mock-feeds");
    expect(names[1]).toBe("liquidate");
  });

  test("perpMarkets from the deployment file: an object or a JSON string; absent = none", () => {
    const base = { chainId: 31337, savingsVault: A(3), crowdBuy: A(4), jitterBeacon: A(5), usdg: A(2) };
    expect(keeperDeployment({ ...base, perpMarkets: { TSLA: M1, AAPL: M2 } }, 31337).perpMarkets).toEqual([M1, M2]);
    expect(perpMarketsOf({ chainId: 1, perpMarkets: JSON.stringify({ TSLA: M1.toLowerCase() }) })).toEqual([M1]);
    expect(keeperDeployment(base, 31337).perpMarkets).toEqual([]);
    expect(perpMarketsOf({ chainId: 1, perpMarkets: "not json" })).toEqual([]);
  });

  test("the mainnet deployment file lists its perp markets", () => {
    const f = join(ROOT, "app", "deployments", "4663.json");
    if (!existsSync(f)) return;
    expect(perpMarketsOf(JSON.parse(readFileSync(f, "utf8"))).length).toBe(4);
  });
});

describe("ABI slice matches contracts/out (skips if not built)", () => {
  const check = (contract: string, abi: readonly any[]) => {
    const f = join(ROOT, "contracts", "out", `${contract}.sol`, `${contract}.json`);
    if (!existsSync(f)) return console.warn(`skip: ${f} not built`);
    const compiled = JSON.parse(readFileSync(f, "utf8")).abi as any[];
    const all = new Set(compiled.filter((x) => x.type === "function" || x.type === "error").map((x) => toFunctionSelector(x)));
    for (const x of abi) if (x.type === "function" || x.type === "error") expect(all.has(toFunctionSelector(x))).toBe(true);
  };
  test("PerpMarket, PerpPool", () => {
    check("PerpMarket", perpMarketKeeperAbi);
    check("PerpPool", perpPoolKeeperAbi);
  });
});
