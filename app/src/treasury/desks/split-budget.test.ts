// review3 R3-TREAS-4 regression. runEquityDesk's "log the refusal of what is left" step used attempt(), which SENDS
// whenever its simulation passes, so after "max sends" (or "min piece") every order got an extra, un-budgeted piece;
// the 16-piece budget was per order, not per name (5 orders gave 85 sends); and an oversized sell was never split.
// Drives the real runEquityDesk against a mocked chain client; the pool fills any order up to 1,000 USDG within the
// slippage and refuses bigger ones with Slippage.
import { describe, expect, test } from "bun:test";
import { ContractFunctionRevertedError, decodeAbiParameters, encodeErrorResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runEquityDesk, MAX_PIECES_PER_NAME, DEFAULT_MIN_PIECE_USDG, type DeskContext } from "@/treasury/desks/runner";
import { MemoryActionLog } from "@/treasury/desks/log";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ACCOUNT = A(0xacc), GUARD = A(0x6a), POLICY = A(0x9), USDG = A(0x05d), VAULT = A(0x7a), AAPL = A(0xaa), EQ = A(0xe9), CASHS = A(0xc5), BEACON = A(0xbe), VALUER = A(0x7e);
const E18 = 10n ** 18n, U = 10n ** 6n;
const DEPTH = 1_000n * U; // the pool takes any buy up to $1k within the guard's 50 bps

const desk = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000e01"); // test-key
const cashKey = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000c01"); // test-key
const slippageErr = () =>
  new ContractFunctionRevertedError({ abi: parseAbi(["error Slippage()"]), data: encodeErrorResult({ abi: parseAbi(["error Slippage()"]), errorName: "Slippage" }), functionName: "execute" });

function ctx(aaplRaw = 0n) {
  const sent: bigint[] = [];
  const now = 1_800_000_000n;
  const beaconState = { windowStart: (now / 86_400n) * 86_400n, windowEnd: (now / 86_400n) * 86_400n + 86_400n, executeAt: 1n, commitment: ("0x" + "11".repeat(32)) as Hex };
  const nav = 1_000_000n * E18;
  const pub: any = {
    getBlock: async () => ({ timestamp: now }),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "guard": return GUARD;
        case "policy": return POLICY;
        case "snapshot": {
          const eqUsd = aaplRaw * 200n;
          const cashUsd = nav - eqUsd;
          return { assets: [USDG, VAULT, AAPL], raw: [cashUsd / 10n ** 12n, 0n, aaplRaw], usd: [cashUsd, 0n, eqUsd], nav, equityHold: false, cashUsd, equityUsd: eqUsd };
        }
        case "trackedAssets": return [[USDG, VAULT, AAPL], [0, 1, 2], [0, 0, 1]];
        case "current": return [{ cash: { minBps: 4000, maxBps: 7000 }, equity: { minBps: 3000, maxBps: 6000 }, perOrderCapUsd: 100_000n, perDayCapUsd: 250_000n, approvalAboveUsd: 50_000n, perNameFloatCapBps: 100, noNewRiskOffHours: true, instrumentAllowRoot: "0x" + "ab".repeat(32) }];
        case "dayTotal": return 0n;
        case "maxOpLossBps": return 50;
        case "assets": return [[AAPL], [2]];
        case "valuer": return VALUER;
        case "decimals": return 18;
        case "floatCapRaw": return 10n ** 30n;
        case "quote": return { priceUsdPerToken: 200n * E18, hold: false };
        case "GRACE": return 600n;
        case "beacon": return beaconState;
        case "keeper": return desk.address;
        case "executeAfter": return 0n;
        default: throw new Error(`unmocked read ${functionName}`);
      }
    },
    simulateContract: async (req: any) => {
      const [, runData] = decodeAbiParameters([{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] }, { type: "bytes" }], req.args[2]);
      const [op, , amount] = decodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint16" }], runData as Hex);
      const usdg = op === 0 ? (amount as bigint) : ((amount as bigint) * 200n) / 10n ** 12n; // a sell's value in USDG 6dp
      if (usdg > DEPTH) throw slippageErr();
      return { request: { ...req, _amount: amount } };
    },
    estimateContractGas: async () => 100_000n,
    request: async () => { throw new Error("no overrides"); },
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }),
  };
  const wallet: any = { writeContract: async (r: any) => { sent.push(r._amount); return ("0x" + sent.length.toString(16).padStart(64, "0")) as Hex; } };
  const c: DeskContext = {
    chain: { id: 31337 } as any,
    pub,
    cfg: {
      account: ACCOUNT, cashSleeve: CASHS, equitySleeve: EQ, vault: VAULT, beacon: BEACON, cashDeskId: "cash", equityDeskId: "equity",
      beaconWindowSeconds: 86_400, proofs: { [AAPL]: [], [USDG]: [], [VAULT]: [] }, allowRoot: ("0x" + "ab".repeat(32)) as Hex,
      cash: { reserveBps: 200, sweepMinBps: 50 } as any, equity: { targetBps: 4500 },
    },
    cash: { account: cashKey, wallet },
    equity: { account: desk, wallet },
    log: new MemoryActionLog(),
  };
  return { c, sent };
}

describe("R3-TREAS-4: split orders stay inside the per-name budget", () => {
  test("a split buy never sends more than MAX_PIECES_PER_NAME pieces per name per pass, and no extra piece", async () => {
    const { c, sent } = ctx();
    await runEquityDesk(c);
    expect(sent.length).toBe(MAX_PIECES_PER_NAME);
    expect(sent.every((a) => a <= DEPTH)).toBe(true);
    const rows = (c.log as MemoryActionLog).rows;
    expect(rows.filter((r) => r.action === "buy" && r.status === "sent").length).toBe(MAX_PIECES_PER_NAME);
    expect(rows.some((r) => r.action === "buy" && r.status === "skipped" && r.reason === "split: max sends")).toBe(true);
    const done = rows.find((r) => r.action === "rebalance_partial" || r.action === "rebalance_done");
    expect(done?.action).toBe("rebalance_partial"); // the rest waits for a later pass
  });

  test("an oversized SELL into a thin pool is split into passing pieces (risk-reducing exits still get out)", async () => {
    const { c, sent } = ctx(4_000n * E18); // $800k AAPL of $1M NAV: 80% equity, band max 60%
    await runEquityDesk(c);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(MAX_PIECES_PER_NAME);
    expect(sent.every((a) => (a * 200n) / 10n ** 12n <= DEPTH)).toBe(true);
    const sells = (c.log as MemoryActionLog).rows.filter((r) => r.action === "sell" && r.status === "sent");
    expect(sells.length).toBe(sent.length);
  });
});
