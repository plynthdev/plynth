// Root cause of the flaky "basis lifecycle" test (t2.anvil.test.ts), pinned down deterministically: a gas
// estimate taken in the same second as PerpMarket's last accrual skips the accrual (block.timestamp ==
// lastAccrual); the same transaction mined later pays for it. With the bare estimate as the gas limit it runs
// out of gas; with withGasHeadroom it goes through.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { withEstimatedGas, withGasHeadroom } from "./gas";
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
  await kit.send(market, "PerpMarket.sol", "PerpMarket", "setParams", [10n, 0n, 50n, 0n, 10n ** 13n, 2000n, 10_000n, 5n * E6]);
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
async function openLongAfterShort(later: bigint, gasFor: (bare: bigint) => bigint) {
  await kit.send(market, "PerpMarket.sol", "PerpMarket", "open", [false, 20_000n * E6, 4_000n * E6, 100n], crowd2);
  const t = await kit.now(); // crowd2's open accrued at t: lastAccrual == t
  const args = [true, 500_000n * E6, 100_000n * E6, 100n] as const;
  // Estimated against the latest block (timestamp t), as a node does while the second has not ticked yet.
  const bare = await kit.pub.estimateContractGas({ address: market, abi: marketAbi(), functionName: "open", args, account: crowd, blockTag: "latest" });
  await kit.pub.request({ method: "evm_setNextBlockTimestamp" as never, params: [Number(t + later)] as never });
  const hash = await kit.wallet(crowd).writeContract({ address: market, abi: marketAbi(), functionName: "open", args, gas: gasFor(bare) });
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

  test("withEstimatedGas sets gas on a simulateContract request", async () => {
    if (!ready) return;
    const { request } = await kit.pub.simulateContract({ address: market, abi: marketAbi(), functionName: "open", args: [false, 1_000n * E6, 500n * E6, 100n], account: crowd2 });
    const est = await kit.pub.estimateContractGas(request as never);
    const r = await withEstimatedGas(kit.pub, request as unknown as Record<string, unknown>);
    expect(r.gas).toBe(withGasHeadroom(est));
    expect(r.functionName).toBe("open");
  }, 60_000);
});

describe("withGasHeadroom", () => {
  test("adds 25% plus a flat 50k and rejects a negative estimate", () => {
    expect(withGasHeadroom(0n)).toBe(50_000n);
    expect(withGasHeadroom(282_000n)).toBe(402_500n);
    expect(() => withGasHeadroom(-1n)).toThrow();
  });
});
