// Unit tests for the fork tooling that does not need a running fork: the caching RPC proxy, the deployment
// split, the report and its exit rule, and the round-up arithmetic the exercise asserts against.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, isPrunedError, RpcCache } from "./rpc-cache";
import { devAccount, FORK_CHAIN_ID, ROLE, splitDeployment } from "./lib";
import { exitCode, renderHtml, renderMarkdown, summarize } from "./exercise/report";
import type { Step } from "./exercise/core";
import { KNOWN_BUGS, type KnownBug } from "./exercise/known-bugs";
import { roundUp } from "./exercise/consumer-flow";
import { parseFundArgs } from "./fund";

type Req = { method: string; params?: unknown[] };

/** A fake upstream; with `pruned`, it answers state reads only at "latest" (the node pruned the fork block). */
function upstream(pruned: boolean) {
  const calls: Req[] = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as Req & { id: unknown };
    calls.push(req);
    const block = req.params?.[req.params.length - 1];
    if (pruned && block !== "latest") return Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "historical state 0xabc is not available" } });
    return Response.json({ jsonrpc: "2.0", id: req.id, result: `0x${(calls.length).toString(16)}` });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("rpc-cache", () => {
  test("cache key keeps the block a slot was asked at", () => {
    expect(cacheKey("eth_getStorageAt", ["0xAB", "0x1", "0x10"])).not.toBe(cacheKey("eth_getStorageAt", ["0xab", "0x1", "0x11"]));
    expect(cacheKey("eth_getStorageAt", ["0xAB", "0x1", "0x10"])).toBe(cacheKey("eth_getStorageAt", ["0xab", "0x1", "0x10"]));
  });

  test("pruned-state errors are recognised", () => {
    expect(isPrunedError({ message: "historical state d9 is not available" })).toBe(true);
    expect(isPrunedError({ message: "missing trie node abc" })).toBe(true);
    expect(isPrunedError({ message: "execution reverted" })).toBe(false);
  });

  test("a state read is fetched once, then served from the cache and from the file after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rpc-cache-"));
    const file = join(dir, "c.jsonl");
    const up = upstream(false);
    const c = new RpcCache("http://upstream", file, up.fetcher);
    const req = { jsonrpc: "2.0" as const, id: 1, method: "eth_getStorageAt", params: ["0xaa", "0x0", "0x10"] };
    const a = await c.handle(req);
    const b = await c.handle({ ...req, id: 2 });
    expect(a.result).toBe(b.result);
    expect(b.id).toBe(2);
    expect(up.calls).toHaveLength(1);
    const again = new RpcCache("http://upstream", file, upstream(false).fetcher);
    expect((await again.handle(req)).result).toBe(a.result);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("when the fork block is pruned upstream, the value at latest is used and pinned", async () => {
    const up = upstream(true);
    const c = new RpcCache("http://upstream", undefined, up.fetcher);
    const r = await c.handle({ jsonrpc: "2.0", id: 7, method: "eth_getCode", params: ["0xbb", "0x10"] });
    expect(r.error).toBeUndefined();
    expect(up.calls.map((x) => x.params?.[1])).toEqual(["0x10", "latest"]);
    expect(c.stats.latestFallbacks).toBe(1);
    await c.handle({ jsonrpc: "2.0", id: 8, method: "eth_getCode", params: ["0xbb", "0x10"] });
    expect(up.calls).toHaveLength(2);
  });

  test("non-state calls pass through uncached; transactions are refused", async () => {
    const up = upstream(false);
    const c = new RpcCache("http://upstream", undefined, up.fetcher);
    await c.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x10", false] });
    await c.handle({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["0x10", false] });
    expect(up.calls).toHaveLength(2);
    const w = await c.handle({ jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: ["0x01"] });
    expect(w.error?.message).toContain("read-only");
    expect(up.calls).toHaveLength(2);
  });

  test("batches are answered element by element", async () => {
    const c = new RpcCache("http://upstream", undefined, upstream(false).fetcher);
    const out = (await c.handleBody([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xcc", "0x1"] },
    ])) as { id: number }[];
    expect(out.map((o) => o.id)).toEqual([1, 2]);
  });
});

describe("fork deployment file", () => {
  test("split: stocks and perp markets parsed, addresses checksummed, deploy block from RPC", () => {
    const raw = {
      chainId: 31337,
      deployBlock: 11843259, // forge's parent-chain number on an Orbit fork: replaced
      usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      treasuryFactory: "0x74156a1f9736307b7ad34e3691f3a5b54a0b3eb8",
      receipts: "0x0000000000000000000000000000000000000001",
      stocks: JSON.stringify({ TSLA: { token: "0x322f0929c4625ed5bad873c95208d54e1c003b2d" } }),
      perpMarkets: JSON.stringify({ TSLA: "0x0000000000000000000000000000000000000002" }),
    };
    const { main, treasury } = splitDeployment(raw, 81646174);
    expect(main.deployBlock).toBe(81646174);
    expect(main.usdg).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(main.stocks.TSLA!.token.toLowerCase()).toBe("0x322f0929c4625ed5bad873c95208d54e1c003b2d");
    expect(main.perpMarkets.TSLA).toBe("0x0000000000000000000000000000000000000002");
    expect(treasury).toMatchObject({ chainId: 31337, treasuryFactoryBlock: 81646174, receipts: "0x0000000000000000000000000000000000000001" });
  });

  test("roles come from anvil's public mnemonic (account 0 is anvil's first account)", () => {
    expect(devAccount(ROLE.deployer).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(devAccount(ROLE.relayer).address).toBe("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720");
    expect(FORK_CHAIN_ID).toBe(31337);
  });
});

const step = (area: string, name: string, status: Step["status"], bug?: string): Step => ({ area, step: name, actor: "a", status, assertion: "x", ms: 1, ...(bug ? { bug } : {}), ...(status !== "pass" ? { detail: "got y" } : {}), tx: status === "pass" ? "0xabc" : undefined, gas: status === "pass" ? "21000" : undefined });

describe("report", () => {
  test("exit 0 only when every failure is a known bug, 1 on any unknown failure or an empty run", () => {
    expect(exitCode([step("a", "s1", "pass"), step("a", "s2", "known", "B1")])).toBe(0);
    expect(exitCode([step("a", "s1", "pass"), step("a", "s2", "fail")])).toBe(1);
    expect(exitCode([])).toBe(1);
  });

  test("summary counts per area, transactions and gas", () => {
    const s = summarize([step("a", "1", "pass"), step("a", "2", "fail"), step("b", "3", "known", "B1")]);
    expect(s).toEqual([
      { area: "a", steps: 2, passed: 1, failed: 1, known: 0, txs: 1, gas: 21000n },
      { area: "b", steps: 1, passed: 0, failed: 0, known: 1, txs: 0, gas: 0n },
    ]);
  });

  test("no known bugs are left (todo 37 fixed B1-B3): every step has to pass", () => {
    expect(KNOWN_BUGS).toEqual([]);
  });

  test("markdown and html list failures with diagnosis and the bugs found; html has no scripts or remote assets", () => {
    const bugs: KnownBug[] = [{ id: "B1", area: "token", steps: ["a known step"], title: "A sample bug", repro: "r", diagnosis: "d" }];
    const steps = [step("token", "a known step", "known", "B1"), step("crowd", "x | y", "fail"), step("crowd", "ok", "pass")];
    const meta = { date: "2026-10-06", startedAt: "s", finishedAt: "f", forkBlock: "1", forkSource: "https://rpc.example", chainId: 31337, notes: ["n"], diagnosis: { "crowd/x | y": "because" } };
    const md = renderMarkdown(meta, steps, bugs);
    expect(md).toContain("## Bugs found");
    expect(md).toContain(bugs[0]!.title);
    expect(md).toContain("Diagnosis: because");
    expect(md).toContain("x \\| y");
    const html = renderHtml(meta, steps, bugs);
    expect(html).not.toMatch(/<script|src=|href=/i);
    expect(html).toContain("known B1");
  });
});

describe("round-up arithmetic (mirrors SavingsVault.roundUp)", () => {
  test("ceil to roundTo whole USDG, minus the spend, times the multiplier; exact multiples give 0", () => {
    expect(roundUp(5_500_000n, 10, 1)).toBe(4_500_000n);
    expect(roundUp(3_200_000n, 5, 2)).toBe(3_600_000n);
    expect(roundUp(7_250_000n, 1, 3)).toBe(2_250_000n);
    expect(roundUp(1_000_000n, 10, 3)).toBe(27_000_000n);
    expect(roundUp(10_000_000n, 10, 3)).toBe(0n);
  });
});

describe("fund.ts arguments", () => {
  test("addresses are checksummed; none means the dev accounts", () => {
    expect(parseFundArgs([])).toEqual([]);
    expect(parseFundArgs(["0x09db0a93b389bef724429898f539aeb7ac2dd55f"])).toEqual(["0x09DB0a93B389bEF724429898f539AEB7ac2Dd55f"]);
  });
  test("anything but an address is refused, and so is the zero address", () => {
    expect(() => parseFundArgs(["0x123"])).toThrow(/not an address/);
    expect(() => parseFundArgs(["--all"])).toThrow(/not an address/);
    expect(() => parseFundArgs([`0x${"0".repeat(40)}`])).toThrow(/zero address/);
  });
});
