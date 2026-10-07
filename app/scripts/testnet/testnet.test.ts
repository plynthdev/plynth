// Rules of the testnet scripts (todo 38): the chain-id guard on every send (never mainnet 4663), the deployment
// rewrite, the funding top-ups and the deployer floor, the exercise schedule (--resume), and the report's explorer
// links and exit code. No network: a local fake JSON-RPC server stands in for a wrong chain.
import { describe, expect, test } from "bun:test";
import { getAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compileTemplate } from "@/treasury/policy-compiler";
import type { Step } from "../fork/exercise/core";
import { testers, affordable, assertTestnetChainId, clients, fmtEth, guardRequest, ledgerTotals, topUpAmount, txUrl, WrongChainError, EXPLORER, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "./lib";
import { deploymentText, deployCostAtBaseFee, envFileText, fundingNeed, keystoreVars, normalizeDeployment, DEPLOYER_FLOOR, ETH_TARGETS, TESTER_ETH } from "./setup";
import { applyOutcome, dueItems, emptyState, schedule, waiting } from "./exercise/state";
import { exitCode, renderHtml, renderMarkdown, type TestnetMeta } from "./exercise/report";
import { roundUp, testnetTemplate } from "./exercise/areas";

const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // test-key (anvil default #0)

/** A JSON-RPC server answering eth_chainId with `chainId`; records every method it was asked. */
function fakeRpc(chainId: number) {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string } | { id: number; method: string }[];
      const one = (m: { id: number; method: string }) => {
        methods.push(m.method);
        const result: Record<string, unknown> = {
          eth_chainId: `0x${chainId.toString(16)}`,
          eth_getTransactionCount: "0x0",
          eth_gasPrice: "0x989680",
          eth_maxPriorityFeePerGas: "0x0",
          eth_estimateGas: "0x5208",
          eth_getBlockByNumber: { baseFeePerGas: "0x989680", number: "0x1", timestamp: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] },
          eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
        };
        return { jsonrpc: "2.0", id: m.id, result: result[m.method] ?? null };
      };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, methods, stop: () => server.stop(true) };
}

describe("network guard: only Robinhood Chain testnet 46630 is ever sent to", () => {
  test("46630 passes, as a number or the hex eth_chainId answer", () => {
    expect(() => assertTestnetChainId(46630)).not.toThrow();
    expect(() => assertTestnetChainId("0xb626")).not.toThrow();
  });
  test("mainnet 4663 is refused by name", () => {
    expect(() => assertTestnetChainId(MAINNET_CHAIN_ID)).toThrow(/MAINNET \(4663\)/);
    expect(() => assertTestnetChainId("0x1237")).toThrow(WrongChainError);
  });
  test("any other chain (a local 31337 fork, Ethereum) is refused", () => {
    expect(() => assertTestnetChainId(31337)).toThrow(/expected testnet 46630/);
    expect(() => assertTestnetChainId(1)).toThrow(WrongChainError);
  });
  test("guardRequest: a send on a 4663 endpoint is refused before it reaches the endpoint", async () => {
    const seen: string[] = [];
    const inner = async (a: { method: string }) => {
      seen.push(a.method);
      return a.method === "eth_chainId" ? "0x1237" : "0xdead";
    };
    const g = guardRequest(inner, "fake");
    await expect(g({ method: "eth_sendRawTransaction", params: ["0x00"] })).rejects.toThrow(/MAINNET/);
    expect(seen).toEqual(["eth_chainId"]);
  });
  test("guardRequest: reads pass straight through; sends on 46630 go out after one chain-id check", async () => {
    const seen: string[] = [];
    const inner = async (a: { method: string }) => {
      seen.push(a.method);
      return a.method === "eth_chainId" ? "0xb626" : "0x1";
    };
    const g = guardRequest(inner, "fake");
    expect(await g({ method: "eth_blockNumber" })).toBe("0x1");
    expect(seen).toEqual(["eth_blockNumber"]);
    expect(await g({ method: "eth_sendRawTransaction", params: ["0x00"] })).toBe("0x1");
    expect(seen).toEqual(["eth_blockNumber", "eth_chainId", "eth_sendRawTransaction"]);
  });
  test("the testnet wallet client never broadcasts to an endpoint that answers 4663", async () => {
    const rpc = fakeRpc(MAINNET_CHAIN_ID);
    try {
      const { wallet } = clients(rpc.url);
      const acct = privateKeyToAccount(ANVIL0);
      await expect(wallet(acct).sendTransaction({ to: acct.address, value: 1n, gas: 21_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n, nonce: 0 } as never)).rejects.toThrow();
      expect(rpc.methods).not.toContain("eth_sendRawTransaction");
    } finally {
      rpc.stop();
    }
  });
  test("the same client does broadcast when the endpoint is 46630 (signed for chain 46630)", async () => {
    const rpc = fakeRpc(TESTNET_CHAIN_ID);
    try {
      const { wallet } = clients(rpc.url);
      const acct = privateKeyToAccount(ANVIL0);
      const hash = await wallet(acct).sendTransaction({ to: acct.address, value: 1n, gas: 21_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n, nonce: 0 } as never);
      expect(hash).toBe(`0x${"ab".repeat(32)}`);
      expect(rpc.methods).toContain("eth_sendRawTransaction");
    } finally {
      rpc.stop();
    }
  });
});

describe("funding and the gas budget", () => {
  test("topUpAmount tops up to the target, never past it, and skips a wallet still at 80% or more", () => {
    expect(topUpAmount(0n, 100n)).toBe(100n);
    expect(topUpAmount(40n, 100n)).toBe(60n);
    expect(topUpAmount(79n, 100n)).toBe(21n);
    expect(topUpAmount(80n, 100n)).toBe(0n);
    expect(topUpAmount(100n, 100n)).toBe(0n);
    expect(topUpAmount(250n, 100n)).toBe(0n);
  });
  test("affordable keeps the deployer at or above the 0.001 ETH floor", () => {
    expect(DEPLOYER_FLOOR).toBe(parseEther("0.001"));
    expect(affordable(parseEther("0.01"), parseEther("0.009"), DEPLOYER_FLOOR)).toBe(true);
    expect(affordable(parseEther("0.01"), parseEther("0.0091"), DEPLOYER_FLOOR)).toBe(false);
  });
  test("the funding plan plus one tester's 0.0005 ETH fits in the 0.01 ETH faucet budget with the floor", () => {
    const plan = Object.values(ETH_TARGETS).reduce((a, b) => a + b!, 0n) + TESTER_ETH;
    expect(TESTER_ETH).toBe(parseEther("0.0005"));
    expect(affordable(parseEther("0.01"), plan + parseEther("0.0015"), DEPLOYER_FLOOR)).toBe(true);
  });
  test("a redeploy budgets only the top-ups still needed and the deploy at the base fee (todo 40)", () => {
    const funded = Object.fromEntries(Object.entries(ETH_TARGETS).map(([r, t]) => [r, t!])) as Record<string, bigint>;
    expect(fundingNeed(funded, [TESTER_ETH])).toBe(0n);
    expect(fundingNeed({ ...funded, keeper: parseEther("0.001") }, [TESTER_ETH])).toBe(parseEther("0.0005")); // 67% < 80%
    expect(fundingNeed({ ...funded, keeper: parseEther("0.00125") }, [0n])).toBe(TESTER_ETH); // keeper at 83%: skipped
    const est = { l2Gas: 180_700_000n, l1Gas: 1_000_000n, gasPrice: 10_000_000n }; // 139M x 1.3, 0.01 gwei
    expect(deployCostAtBaseFee(est)).toBe(181_700_000n * 10_000_000n);
    // 2026-10-07: 0.004365 ETH left covers a ~0.0018 ETH redeploy and keeps the 0.001 floor.
    expect(affordable(parseEther("0.004365"), deployCostAtBaseFee(est), DEPLOYER_FLOOR)).toBe(true);
  });
  test("ledgerTotals sums fees and value per sender", () => {
    const t = ledgerTotals([
      { at: "", what: "a", from: "deployer", feeWei: "10", valueWei: "100" },
      { at: "", what: "b", from: "deployer", feeWei: "5" },
      { at: "", what: "c", from: "keeper", feeWei: "7" },
    ]);
    expect(t.deployer).toEqual({ fees: 15n, sent: 100n, txs: 2 });
    expect(t.keeper).toEqual({ fees: 7n, sent: 0n, txs: 1 });
  });
  test("fmtEth prints up to 6 decimals", () => {
    expect(fmtEth(parseEther("0.00139"))).toBe("0.00139");
    expect(fmtEth(parseEther("1"))).toBe("1");
    expect(fmtEth(0n)).toBe("0");
    expect(fmtEth(-parseEther("0.5"))).toBe("-0.5");
  });
});

describe("tester wallets (kept out of the repository)", () => {
  test("TESTNET_TESTERS wins, comma or whitespace separated, checksummed, deduplicated", () => {
    const a = "0x00000000000000000000000000000000000000a1";
    expect(testers({ TESTNET_TESTERS: `${a}, ${a}\n0x00000000000000000000000000000000000000B2` }, "/nonexistent")).toEqual([getAddress(a), getAddress("0x00000000000000000000000000000000000000b2")]);
  });
  test("no env and no file: nobody is funded", () => {
    expect(testers({}, "/nonexistent")).toEqual([]);
  });
  test("a malformed entry is refused", () => {
    expect(() => testers({ TESTNET_TESTERS: "0x123" }, "/nonexistent")).toThrow(/not an address/);
  });
});

describe("deployment file", () => {
  const raw = {
    chainId: 46630,
    deployBlock: 11843259, // forge's parent-chain block on Orbit
    usdg: "0xd4d641db556982c4e18aa94f7fa8d78f79d1600b",
    treasuryFactory: "0xfe678cc84d33b81a6169be1b092227847cad9967",
    policyGuard: "0x7edce82627682e43eb2845cee813d137ac6db369",
    receipts: "0x962684ebe142f2e7f3cec55fe2f201e379b6574f",
    templateRegistry: "0x5cb47a7eca08cb8ee04f4838e9244410fc4cb1f3",
    stocks: JSON.stringify({ mTSLA: { token: "0x37Ea7Ef027Fd3B6746c3542EE149b948E3183003", uiMultiplier: "1000000000000000000" } }),
    perpMarkets: JSON.stringify({ mTSLA: "0x60e10Ae558dbdEc1C53F5347C2D6A18A38b9355D" }),
  };
  test("deployBlock becomes the L2 block, nested JSON becomes objects, addresses are checksummed", () => {
    const { main, treasury } = normalizeDeployment(raw, 130077131);
    expect(main.deployBlock).toBe(130077131);
    expect(main.treasuryFactoryBlock).toBe(130077131);
    expect(main.usdg).toBe(getAddress(raw.usdg));
    expect((main.stocks as Record<string, { uiMultiplier: string }>).mTSLA!.uiMultiplier).toBe("1000000000000000000");
    expect((main.perpMarkets as Record<string, string>).mTSLA).toBe("0x60e10Ae558dbdEc1C53F5347C2D6A18A38b9355D");
    expect(treasury).toEqual({ chainId: 46630, treasuryFactory: getAddress(raw.treasuryFactory), treasuryFactoryBlock: 130077131, policyGuard: getAddress(raw.policyGuard), receipts: getAddress(raw.receipts), templateRegistry: getAddress(raw.templateRegistry) });
  });
  test("pool ids carry the public guard's not-a-key marker on their own line and the JSON still parses", () => {
    const id = `0x${"ab".repeat(32)}`;
    const text = deploymentText({ plthPoolId: id, stocks: { mTSLA: { poolId: id, fee: 3000 } } });
    const lines = text.split("\n").filter((l) => l.includes(id));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain("// not-a-key");
    const back = JSON.parse(text);
    expect(back.plthPoolId).toBe(id);
    expect(back.stocks.mTSLA.poolId).toBe(id);
    expect(back.stocks.mTSLA.fee).toBe(3000);
  });
  test("a file for any other chain is refused", () => {
    expect(() => normalizeDeployment({ ...raw, chainId: 4663 }, 1)).toThrow(/not 46630/);
  });
});

describe("service env files", () => {
  test("signers are keystore + password-file PATHS, never a key", () => {
    const v = keystoreVars("KEEPER", "keeper");
    expect(Object.keys(v).sort()).toEqual(["KEEPER_KEYSTORE", "KEEPER_KEYSTORE_PASSWORD_FILE"]);
    expect(v.KEEPER_KEYSTORE!.endsWith("/plynth-keeper")).toBe(true);
    expect(v.KEEPER_KEYSTORE_PASSWORD_FILE!.endsWith("/plynth-keeper.password")).toBe(true);
    expect(Object.values(v).some((s) => /^0x[0-9a-fA-F]{64}$/.test(s))).toBe(false);
  });
  test("envFileText drops empty values", () => {
    expect(envFileText({ A: 1, B: "", C: undefined, D: "x" })).toBe("A=1\nD=x\n");
  });
});

describe("exercise schedule (--resume)", () => {
  test("schedule adds once, updates a waiting step, never reopens a done one", () => {
    const s = emptyState(46630, "0xvault");
    schedule(s, { id: "a", handler: "h", area: "x", title: "t", dueAt: 100 });
    schedule(s, { id: "a", handler: "h", area: "x", title: "t2", dueAt: 200 });
    expect(s.scheduled).toHaveLength(1);
    expect(s.scheduled[0]!.dueAt).toBe(200);
    applyOutcome(s.scheduled[0]!, { status: "done" }, "now");
    schedule(s, { id: "a", handler: "h", area: "x", title: "t3", dueAt: 300 });
    expect(s.scheduled[0]!.status).toBe("done");
    expect(s.scheduled[0]!.dueAt).toBe(200);
  });
  test("dueItems: due and not done, earliest first; failed ones are retried; waiting lists the rest", () => {
    const s = emptyState(46630, "0xvault");
    schedule(s, { id: "late", handler: "h", area: "x", title: "", dueAt: 500 });
    schedule(s, { id: "b", handler: "h", area: "x", title: "", dueAt: 200 });
    schedule(s, { id: "a", handler: "h", area: "x", title: "", dueAt: 100 });
    schedule(s, { id: "done", handler: "h", area: "x", title: "", dueAt: 50, status: "done" });
    schedule(s, { id: "failed", handler: "h", area: "x", title: "", dueAt: 60, status: "failed" });
    expect(dueItems(s, 300).map((i) => i.id)).toEqual(["failed", "a", "b"]);
    expect(waiting(s, 300).map((i) => i.id)).toEqual(["late"]);
  });
  test("applyOutcome: later moves the due time and keeps it scheduled", () => {
    const s = emptyState(46630, "0xvault");
    const it = schedule(s, { id: "a", handler: "h", area: "x", title: "", dueAt: 100 });
    applyOutcome(it, { status: "later", dueAt: 900, detail: "beacon not revealed" }, "now");
    expect(it).toMatchObject({ status: "scheduled", dueAt: 900, detail: "beacon not revealed" });
    applyOutcome(it, { status: "failed", detail: "boom" }, "now");
    expect(it.status).toBe("failed");
  });
});

describe("report", () => {
  const meta: TestnetMeta = { date: "2026-10-06", generatedAt: "2026-10-06T21:00:00Z", rpc: "https://rpc.testnet.chain.robinhood.com", chainId: 46630, deployBlock: 130077131, deployment: { savingsVault: "0x6d7F16Ecc1E950db5C1768Be1c5a24af238Bf1eF" }, runs: [{ mode: "run", startedAt: "a", finishedAt: "b" }], notes: [], balances: [{ role: "deployer", address: "0x926cd0526C92827688EA67dE891bE6fE1945643b", wei: "4402583210000000" }] };
  const tx = `0x${"cd".repeat(32)}` as Hex;
  const steps: Step[] = [{ area: "savings", step: "open: deposit", actor: "open", tx, gas: "83569", status: "pass", assertion: "available = 300", ms: 1 }];
  const sched = emptyState(46630, "v");
  schedule(sched, { id: "crowd-execution", handler: "crowd-execution", area: "crowd", title: "books execute", dueAt: 1791331200 });
  test("every transaction links to the testnet explorer (markdown and HTML)", () => {
    expect(txUrl(tx)).toBe(`${EXPLORER}/tx/${tx}`);
    expect(EXPLORER).toBe("https://explorer.testnet.chain.robinhood.com");
    expect(renderMarkdown(meta, steps, sched.scheduled, [])).toContain(`(${EXPLORER}/tx/${tx})`);
    expect(renderHtml(meta, steps, sched.scheduled, [])).toContain(`href="${EXPLORER}/tx/${tx}"`);
  });
  test("waiting steps read 'scheduled: due at <time>'", () => {
    expect(renderMarkdown(meta, steps, sched.scheduled, [])).toContain("scheduled: due at 2026-10-07T00:00:00Z");
  });
  test("exit code: 0 with all steps passed and nothing failed; 1 on a failed step or a failed scheduled step", () => {
    expect(exitCode(steps, sched.scheduled)).toBe(0);
    expect(exitCode([...steps, { ...steps[0]!, status: "fail" }], sched.scheduled)).toBe(1);
    const failed = emptyState(46630, "v");
    schedule(failed, { id: "x", handler: "h", area: "a", title: "", dueAt: 1, status: "failed" });
    expect(exitCode(steps, failed.scheduled)).toBe(1);
    expect(exitCode([], [])).toBe(1);
  });
});

describe("exercise rules", () => {
  test("round-up = (ceil(spend / roundTo) x roundTo - spend) x multiplier", () => {
    expect(roundUp(7_350_000n, 10, 1)).toBe(2_650_000n);
    expect(roundUp(12_300_000n, 5, 2)).toBe(5_400_000n);
    expect(roundUp(12_300_000n, 1, 3)).toBe(2_100_000n);
    expect(roundUp(10_000_000n, 10, 3)).toBe(0n);
  });
  test("the testnet treasury template compiles on the mock addresses and leaves mSPY out (guard rule 2 case)", () => {
    const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const fake = { addr: (k: string) => a(k.length), token: (s: string) => a(({ mTSLA: 101, mAAPL: 102, mSPY: 103 } as Record<string, number>)[s]!) } as never;
    const c = compileTemplate(testnetTemplate(fake, a(999)) as never, { controller: a(999), network: "testnet" });
    expect(c.instruments).toHaveLength(4);
    expect(c.policy.perOrderCapUsd).toBe(500n);
    expect(c.policy.approvalAboveUsd).toBe(300n);
    const tokens = c.instruments.map((i) => i.asset);
    expect(tokens).not.toContain((fake as { token: (s: string) => string }).token("mSPY"));
  });
});

describe("public-RPC hiccups (2026-10-07)", () => {
  test("transient RPC errors are retried, reverts never", async () => {
    const { transientRpcError, retryTransient } = await import("../fork/exercise/core");
    expect(transientRpcError(new Error("Missing or invalid parameters.\nDouble check you have provided the correct parameters."))).toBe(true);
    expect(transientRpcError(new Error("HTTP request failed. Status: 503"))).toBe(true);
    expect(transientRpcError(new Error("execution reverted: NotKeeper()"))).toBe(false);
    expect(transientRpcError(new Error("The contract function \"execute\" reverted."))).toBe(false);
    let n = 0;
    expect(await retryTransient(async () => (++n < 2 ? Promise.reject(new Error("Missing or invalid parameters.")) : 7))).toBe(7);
    expect(n).toBe(2);
    n = 0;
    await expect(retryTransient(async () => { n++; throw new Error("execution reverted"); })).rejects.toThrow("reverted");
    expect(n).toBe(1);
  });
});
