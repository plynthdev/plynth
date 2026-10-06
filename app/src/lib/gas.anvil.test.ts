// Root cause of the flaky "basis lifecycle" test (t2.anvil.test.ts), pinned down deterministically: a gas
// estimate taken in the same second as PerpMarket's last accrual skips the accrual (block.timestamp ==
// lastAccrual); the same transaction mined later pays for it. With the bare estimate as the gas limit it runs
// out of gas; with withGasHeadroom it goes through. Todo 37 fixes it at the source: estimateGasAhead also prices
// the call one second ahead (eth_estimateGas block override), so even with no headroom at all the limit covers
// the accrual.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { estimateAt, estimateGasAhead, withEstimatedGas, withGasHeadroom, type GasClient } from "./gas";
import { spawnAnvil, type Anvil } from "@/testing/anvil";
import { artifact, Kit, ROOT } from "@/testing/treasury-kit";

const E6 = 10n ** 6n;
const crowd = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // test-key (anvil #3)
const crowd2 = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"); // test-key (anvil #4)
const marketAbi = () => artifact("PerpMarket.sol", "PerpMarket").abi;

let anvil: Anvil | undefined;
let kit: Kit;
let market: `0x${string}`;
let ready = false;

beforeAll(async () => {
  if (!Bun.which("anvil") || !existsSync(join(ROOT, "contracts", "out", "PerpMarket.sol"))) return;
  anvil = await spawnAnvil();
  kit = new Kit(anvil.rpc);
  await kit.setup(mkdtempSync(join(tmpdir(), "plynth-gas-")), 1_000n * E6);
  const d = kit.deployer.address;
  const tsla = kit.stocks.find((s) => s.sym === "mTSLA")!;
  const pool = await kit.deploy("PerpPool.sol", "PerpPool", [kit.a.usdg, d]);
  market = await kit.deploy("PerpMarket.sol", "PerpMarket", [pool, kit.a.valuer, tsla.token, d]);
  await kit.send(pool, "PerpPool.sol", "PerpPool", "addMarket", [market]);
  // Same parameters as t2: skew funding (fundingK 1e13), 10 bps taker fee.
  await kit.send(market, "PerpMarket.sol", "PerpMarket", "setParams", [10n, 0n, 1000n, 0n, 10n ** 13n, 2000n, 10_000n, 5n * E6]);
  await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "mint", [d, 10_000_000n * E6]);
  await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "approve", [pool, 2n ** 255n]);
  await kit.send(pool, "PerpPool.sol", "PerpPool", "deposit", [10_000_000n * E6, d]);
  for (const c of [crowd, crowd2]) {
    await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "mint", [c.address, 1_000_000n * E6]);
    await kit.send(kit.a.usdg!, "MockUSDG.sol", "MockUSDG", "approve", [pool, 2n ** 255n], c);
  }
  ready = true;
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
});

/** The t2 opening: crowd2 short, then (estimated in the same second) crowd long, mined `later` seconds after. */
async function openLongAfterShort(later: bigint, gasFor: (bare: bigint, call: Parameters<typeof estimateGasAhead>[1]) => bigint | Promise<bigint>) {
  await kit.send(market, "PerpMarket.sol", "PerpMarket", "open", [false, 20_000n * E6, 4_000n * E6, 100n], crowd2);
  const t = await kit.now(); // crowd2's open accrued at t: lastAccrual == t
  const args = [true, 500_000n * E6, 100_000n * E6, 100n] as const;
  const call = { address: market, abi: marketAbi(), functionName: "open", args, account: crowd.address };
  // Estimated in the accrual's own second (timestamp t), as a node does while the second has not ticked yet. The
  // block override pins it: whether anvil's own "latest" estimate already sits in the next second depends on the
  // wall clock.
  const bare = await estimateAt(kit.pub as unknown as GasClient, call, 0n);
  const gas = await gasFor(bare, call);
  await kit.pub.request({ method: "evm_setNextBlockTimestamp" as never, params: [Number(t + later)] as never });
  const hash = await kit.wallet(crowd).writeContract({ address: market, abi: marketAbi(), functionName: "open", args, gas });
  const r = await kit.pub.waitForTransactionReceipt({ hash });
  return { bare, receipt: r };
}

async function closeBoth() {
  for (const c of [crowd, crowd2]) {
    const p = await kit.read<{ size: bigint }>(market, "PerpMarket.sol", "PerpMarket", "position", [c.address]);
    if (p.size !== 0n) await kit.send(market, "PerpMarket.sol", "PerpMarket", "close", [], c);
  }
}

describe("gas headroom (lib/gas.ts) against PerpMarket's per-second accrual", () => {
  test("bare estimate from the accrual's own second runs out of gas when mined a second later", async () => {
    if (!ready) return;
    try {
      const { bare, receipt } = await openLongAfterShort(1n, (g) => g);
      expect(receipt.status).toBe("reverted");
      // The limit burned (all but the 1/64 a reverting subcall leaves behind): out of gas, not a logic revert.
      expect(receipt.gasUsed * 64n >= bare * 63n).toBe(true);
    } finally {
      await closeBoth();
    }
  }, 60_000);

  test("the same estimate with withGasHeadroom goes through and pays for the accrual it skipped", async () => {
    if (!ready) return;
    try {
      const { bare, receipt } = await openLongAfterShort(1n, withGasHeadroom);
      expect(receipt.status).toBe("success");
      expect(receipt.gasUsed > bare).toBe(true);
      expect(receipt.gasUsed <= withGasHeadroom(bare)).toBe(true);
    } finally {
      await closeBoth();
    }
  }, 60_000);

  test("the estimate one second ahead prices the accrual the plain estimate skipped", async () => {
    if (!ready) return;
    try {
      let ahead = 0n;
      const { bare, receipt } = await openLongAfterShort(1n, async (b, call) => {
        ahead = await estimateAt(kit.pub as unknown as GasClient, call, 1n);
        expect(await estimateGasAhead(kit.pub as unknown as GasClient, call)).toBe(ahead > b ? ahead : b);
        return withGasHeadroom(ahead);
      });
      expect(receipt.status).toBe("success");
      expect(ahead > bare).toBe(true);
      expect(receipt.gasUsed > bare).toBe(true);
      expect(receipt.gasUsed <= ahead).toBe(true);
    } finally {
      await closeBoth();
    }
  }, 60_000);

  test("fixed at the source: estimateGasAhead with no headroom at all goes through a second later", async () => {
    if (!ready) return;
    try {
      const { bare, receipt } = await openLongAfterShort(1n, (_b, call) => estimateGasAhead(kit.pub as unknown as GasClient, call));
      expect(receipt.status).toBe("success");
      expect(receipt.gasUsed > bare).toBe(true);
    } finally {
      await closeBoth();
    }
  }, 60_000);

  test("withEstimatedGas sets gas on a simulateContract request", async () => {
    if (!ready) return;
    const { request } = await kit.pub.simulateContract({ address: market, abi: marketAbi(), functionName: "open", args: [false, 1_000n * E6, 500n * E6, 100n], account: crowd2 });
    const est = await estimateGasAhead(kit.pub as unknown as GasClient, request as never);
    const r = await withEstimatedGas(kit.pub as unknown as GasClient, request as unknown as Record<string, unknown>);
    expect(r.gas).toBe(withGasHeadroom(est));
    expect(r.functionName).toBe("open");
  }, 60_000);
});

describe("estimateGasAhead fallbacks", () => {
  const call = { address: "0x0000000000000000000000000000000000000001" as const, abi: [{ type: "function", name: "f", inputs: [], outputs: [], stateMutability: "nonpayable" }] as const, functionName: "f", account: "0x0000000000000000000000000000000000000002" as const };
  const client = (ahead: () => Promise<unknown>): GasClient => ({
    estimateContractGas: async () => 100_000n,
    getBlock: async () => ({ timestamp: 1_000n }),
    request: async () => ahead(),
  });

  test("a node that rejects block overrides falls back to the plain estimate", async () => {
    expect(await estimateGasAhead(client(() => Promise.reject(new Error("invalid params"))), call)).toBe(100_000n);
  });

  test("takes the larger of the two estimates", async () => {
    expect(await estimateGasAhead(client(async () => "0x249f0"), call)).toBe(150_000n);
    expect(await estimateGasAhead(client(async () => "0xc350"), call)).toBe(100_000n);
  });

  test("sends the block override one second past the latest block", async () => {
    let params: any;
    const c: GasClient = { estimateContractGas: async () => 1n, getBlock: async () => ({ timestamp: 1_000n }), request: async (a) => ((params = a.params), "0x1") };
    await estimateGasAhead(c, call);
    expect(params[1]).toBe("latest");
    expect(params[3]).toEqual({ time: "0x3e9" });
    expect(params[0].from).toBe(call.account);
    expect(params[0].data).toBe("0x26121ff0");
  });

  test("a revert in the plain estimate propagates", async () => {
    const c: GasClient = { estimateContractGas: () => Promise.reject(new Error("execution reverted")), getBlock: async () => ({ timestamp: 1n }), request: async () => "0x1" };
    await expect(estimateGasAhead(c, call)).rejects.toThrow("execution reverted");
  });
});

describe("withGasHeadroom", () => {
  test("adds 25% plus a flat 50k and rejects a negative estimate", () => {
    expect(withGasHeadroom(0n)).toBe(50_000n);
    expect(withGasHeadroom(282_000n)).toBe(402_500n);
    expect(() => withGasHeadroom(-1n)).toThrow();
  });
});
