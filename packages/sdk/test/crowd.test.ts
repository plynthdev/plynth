// @plynth/sdk/crowd: transaction builders, the contract arithmetic it mirrors, and allocation recomputation.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toEventSelector, toFunctionSelector, type Address, type PublicClient } from "viem";
import {
  allocation,
  beaconKey,
  cancelTx,
  claimOpenTx,
  crowdBuyAbi,
  executeTx,
  jitterBeaconAbi,
  joinTx,
  recomputeBook,
  savingsVaultAbi,
  setMixTx,
  setSettingsTx,
  splitByMix,
  validateMix,
  vaultDepositTx,
  vaultWithdrawTx,
  windowOf,
} from "../src/crowd";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const CROWD = A(0xc0);
const VAULT = A(0xa11);
const TSLA = A(0x751a);
const rand = (max: bigint) => BigInt(Math.floor(Math.random() * Number(max)));

describe("transaction builders", () => {
  test("each builder targets the right contract and encodes the right call", () => {
    const cases = [
      [joinTx(CROWD, A(1)), crowdBuyAbi, "join", [A(1)]],
      [cancelTx(CROWD, TSLA, 3n), crowdBuyAbi, "cancel", [TSLA, 3n]],
      [executeTx(CROWD, TSLA), crowdBuyAbi, "execute", [TSLA]],
      [claimOpenTx(CROWD, TSLA, 7n), crowdBuyAbi, "claimOpen", [TSLA, 7n]],
      [vaultDepositTx(VAULT, 5n), savingsVaultAbi, "deposit", [5n]],
      [vaultWithdrawTx(VAULT, 5n, A(9)), savingsVaultAbi, "withdraw", [5n, A(9)]],
    ] as const;
    for (const [tx, abi, fn, args] of cases) {
      const d = decodeFunctionData({ abi: abi as any, data: tx.data });
      expect(d.functionName).toBe(fn);
      expect(d.args as unknown[]).toEqual(args as unknown as unknown[]);
      expect(tx.to).toBe(abi === crowdBuyAbi ? CROWD : VAULT);
    }
    const s = decodeFunctionData({ abi: savingsVaultAbi, data: setSettingsTx(VAULT, { roundTo: 5, multiplier: 2, weeklyCap: 9n, fixedTopUp: 0n, mode: 1 }).data });
    expect(s.args[0]).toEqual({ roundTo: 5, multiplier: 2, weeklyCap: 9n, fixedTopUp: 0n, mode: 1 });
  });

  test("setMix: validated like SavingsVault.setMix (1-5 distinct tokens, positive weights summing to 10000)", () => {
    const ok = [{ stockToken: TSLA, weightBps: 6000 }, { stockToken: A(2), weightBps: 4000 }];
    expect(decodeFunctionData({ abi: savingsVaultAbi, data: setMixTx(VAULT, ok).data }).args[0]).toEqual(ok);
    expect(() => validateMix([])).toThrow(/1-5/);
    expect(() => validateMix(Array.from({ length: 6 }, (_, i) => ({ stockToken: A(i + 1), weightBps: i === 0 ? 5000 : 1000 })))).toThrow(/1-5/);
    expect(() => validateMix([{ stockToken: TSLA, weightBps: 9999 }])).toThrow(/sum/);
    expect(() => validateMix([{ stockToken: TSLA, weightBps: 0 }, { stockToken: A(2), weightBps: 10000 }])).toThrow(/positive/);
    expect(() => validateMix([{ stockToken: TSLA, weightBps: 5000 }, { stockToken: TSLA.toLowerCase() as Address, weightBps: 5000 }])).toThrow(/distinct/);
  });
});

describe("contract arithmetic", () => {
  test("splitByMix: floors, last entry takes the remainder, always sums exactly (fuzz)", () => {
    for (let i = 0; i < 3000; i++) {
      const n = 1 + (i % 5);
      const w = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 1000));
      const total = w.reduce((a, b) => a + b, 0);
      const bps = w.map((x) => Math.floor((x * 10000) / total));
      bps[n - 1]! += 10000 - bps.reduce((a, b) => a + b, 0);
      if (bps.some((x) => x <= 0)) continue;
      const mix = bps.map((weightBps, j) => ({ stockToken: A(j + 1), weightBps }));
      const amount = rand(10n ** 12n) + BigInt(i);
      const parts = splitByMix(amount, mix);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(amount);
      for (let j = 0; j < n - 1; j++) expect(parts[j]).toBe((amount * BigInt(bps[j]!)) / 10000n);
    }
  });

  test("allocation: floor(rawOut*order/total); allocations never exceed rawOut and dust < accounts (fuzz)", () => {
    expect(allocation(10n, 1n, 0n)).toBe(0n);
    for (let i = 0; i < 2000; i++) {
      const orders = Array.from({ length: 1 + (i % 40) }, () => 1n + rand(10n ** 9n));
      const total = orders.reduce((a, b) => a + b, 0n);
      const rawOut = rand(10n ** 18n) * 1000n + BigInt(i);
      const allocs = orders.map((o) => allocation(rawOut, o, total));
      const sum = allocs.reduce((a, b) => a + b, 0n);
      expect(sum).toBeLessThanOrEqual(rawOut);
      expect(rawOut - sum).toBeLessThan(BigInt(orders.length));
    }
  });

  test("windowOf: fixed 24h grid from genesis, before genesis throws", () => {
    const g = 1_700_000_000n - (1_700_000_000n % 86_400n);
    expect(windowOf(g, g)).toEqual({ start: g, end: g + 86_400n });
    expect(windowOf(g, g + 86_399n).start).toBe(g);
    expect(windowOf(g, g + 86_400n).start).toBe(g + 86_400n);
    expect(() => windowOf(g, g - 1n)).toThrow(/genesis/);
  });

  test("beaconKey = keccak256(abi.encode(asset, uint64 windowStart)), as CrowdBuy.beaconKey", () => {
    const w = 1_700_006_400n;
    expect(beaconKey(TSLA, w)).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TSLA, w])));
    expect(beaconKey(TSLA.toLowerCase() as Address, w)).toBe(beaconKey(TSLA, w));
  });
});

describe("recomputeBook (allocation proof from logs)", () => {
  type L = { name: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number };
  const fakeClient = (logs: L[]) =>
    ({
      getLogs: async ({ event }: any) => logs.filter((l) => l.name === event.name),
    }) as unknown as PublicClient;
  const j = (user: Address, usdg: bigint, blockNumber: bigint, logIndex = 0): L => ({ name: "Joined", args: { asset: TSLA, bookId: 0n, user, usdg }, blockNumber, logIndex });
  const c = (user: Address, usdg: bigint, blockNumber: bigint): L => ({ name: "Cancelled", args: { asset: TSLA, bookId: 0n, user, usdg }, blockNumber, logIndex: 0 });
  const ex = (usdgTotal: bigint, rawOut: bigint, accounts: number): L => ({ name: "Executed", args: { asset: TSLA, bookId: 0n, usdgTotal, rawOut, accounts, roundId: 1n }, blockNumber: 99n, logIndex: 0 });

  test("sums joins per user, replays cancel then re-join in chain order, allocations match the formula", async () => {
    const [u1, u2, u3] = [A(1), A(2), A(3)];
    const logs = [j(u1, 10n, 1n), j(u2, 20n, 2n), j(u1, 5n, 3n), c(u3, 7n, 5n), j(u3, 7n, 4n), j(u3, 30n, 6n), ex(65n, 1000n, 3)];
    // lower-case user in a log is normalised to the checksummed key
    logs[1]!.args.user = u2.toLowerCase();
    const r = await recomputeBook(fakeClient(logs), CROWD, TSLA, 0n);
    expect(r.orders.get(u1)).toBe(15n);
    expect(r.orders.get(u2)).toBe(20n);
    expect(r.orders.get(u3)).toBe(30n); // the 7 was cancelled before re-joining
    expect(r.allocations.get(u1)).toBe((1000n * 15n) / 65n);
    expect(r.allocations.get(u3)).toBe((1000n * 30n) / 65n);
  });

  test("not executed, or logs that do not add up to Executed, throw", async () => {
    await expect(recomputeBook(fakeClient([j(A(1), 10n, 1n)]), CROWD, TSLA, 0n)).rejects.toThrow(/not executed/);
    await expect(recomputeBook(fakeClient([j(A(1), 10n, 1n), ex(11n, 5n, 1)]), CROWD, TSLA, 0n)).rejects.toThrow(/add up/);
    await expect(recomputeBook(fakeClient([j(A(1), 10n, 1n), ex(10n, 5n, 2)]), CROWD, TSLA, 0n)).rejects.toThrow(/add up/);
  });
});

const OUT = join(import.meta.dir, "..", "..", "..", "contracts", "out");
const built = existsSync(join(OUT, "CrowdBuy.sol", "CrowdBuy.json"));
describe.skipIf(!built)("ABIs match the compiled contracts (skips if contracts/out is not built)", () => {
  const compiled = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).abi as any[];
  const sigs = (abi: readonly any[], type: "function" | "event" | "error") =>
    abi.filter((x) => x.type === type).map((x) => (type === "event" ? toEventSelector(x) : toFunctionSelector(x)));
  for (const [file, name, ours] of [
    ["CrowdBuy.sol", "CrowdBuy", crowdBuyAbi],
    ["SavingsVault.sol", "SavingsVault", savingsVaultAbi],
    ["JitterBeacon.sol", "JitterBeacon", jitterBeaconAbi],
  ] as const) {
    test(`${name}: every function, event and error we declare exists with the same signature`, () => {
      const abi = compiled(file, name);
      for (const t of ["function", "event", "error"] as const) {
        const theirs = new Set(sigs(abi, t));
        for (const s of sigs(ours, t)) expect(theirs.has(s)).toBe(true);
      }
    });
  }
});
