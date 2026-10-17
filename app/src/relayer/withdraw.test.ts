// POST /withdraw (Hidden Vault) with stubbed chain reads.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { parseWithdraw, relayerApp, type RelayerDeps, type WithdrawArgs, type WithdrawDeps } from "./app";
import { NonceManager, parseMinFees, relayerTables } from "./chain";
import { ipKey, RateLimiter } from "./ratelimit";

const POOL = "0x00000000000000000000000000000000000000b1" as Address;
const VAULT = "0x0000000000000000000000000000000000000a11" as Address;
const ASSET = "0x00000000000000000000000000000000000070c1" as Address;
const DEST = "0x000000000000000000000000000000000000De57" as Address;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function req(o: Partial<{ recipient: string; amount: string; relayerFee: string; nullifier: Hex; root: Hex; proof: string; encryptedChange: string }> = {}) {
  return {
    proof: o.proof ?? "0x" + "ab".repeat(100),
    pub: {
      root: o.root ?? word(1),
      nullifier: o.nullifier ?? word(2),
      changeCommitment: word(3),
      asset: ASSET,
      amount: o.amount ?? "1000",
      recipient: o.recipient ?? DEST,
      relayerFee: o.relayerFee ?? "10",
      encryptedChange: o.encryptedChange ?? "0x" + "cd".repeat(141),
    },
  };
}

function setup(over: Partial<WithdrawDeps> = {}, deps: Partial<RelayerDeps> = {}) {
  const sent: WithdrawArgs[] = [];
  const spent = new Set<string>();
  const w: WithdrawDeps = {
    pool: POOL,
    minFee: (a) => (a.toLowerCase() === ASSET.toLowerCase() ? 5n : 0n),
    nullifierSpent: async (n) => spent.has(n),
    isKnownRoot: async (r) => r === word(1),
    simulate: async () => ({ ok: true }),
    send: async (a) => {
      sent.push(a);
      spent.add(a.pub.nullifier);
      return `0x${"ee".repeat(32)}` as Hex;
    },
    ...over,
  };
  const app = relayerApp({
    chainId: 31337,
    stealthClaims: "0x00000000000000000000000000000000000005c0",
    plynth: [VAULT],
    relayer: "0x0000000000000000000000000000000000000001",
    nonceOf: async () => 0n,
    balanceOf: async () => 0n,
    simulate: async () => ({ ok: true }),
    send: async () => "0x",
    ipOf: (c) => c.req.header("x-test-ip") ?? "1.1.1.1",
    withdraw: w,
    ...deps,
  });
  const post = (body: unknown, ip = "1.1.1.1") =>
    app.request("/withdraw", { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { post, sent };
}

describe("POST /withdraw", () => {
  test("valid: checked, simulated, sent; returns the tx hash; the args are passed through exactly", async () => {
    const s = setup();
    const r = await s.post(req());
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).txHash).toBe(`0x${"ee".repeat(32)}`);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.pub.amount).toBe(1000n);
    expect(s.sent[0]!.pub.relayerFee).toBe(10n);
  });

  test("a spent note (replay) is refused before simulation", async () => {
    const s = setup();
    await s.post(req());
    const r = await s.post(req());
    expect(r.status).toBe(409);
    expect(s.sent).toHaveLength(1);
  });

  test("unknown root, fee below minimum, Plynth recipient, simulation revert", async () => {
    const s = setup({ simulate: async () => ({ ok: false, error: "InvalidProof" }) });
    expect((await s.post(req({ root: word(9) }))).status).toBe(400);
    const low = await s.post(req({ relayerFee: "4" }));
    expect(low.status).toBe(400);
    expect(((await low.json()) as any).error).toContain("minimum");
    expect((await s.post(req({ recipient: VAULT }))).status).toBe(400);
    expect((await s.post(req({ recipient: POOL }))).status).toBe(400);
    const sim = await s.post(req());
    expect(sim.status).toBe(400);
    const simJson = (await sim.json()) as any;
    expect(simJson.error).toContain("InvalidProof");
    // L-9: a fee-paying proof that fails tells the user which address the proof must bind
    expect(simJson.error).toContain("must bind this relayer: 0x0000000000000000000000000000000000000001");
    expect(s.sent).toHaveLength(0);
  });

  test("shape: bad JSON, fee above amount, oversized note/proof, non-words", async () => {
    const s = setup();
    expect((await s.post("{")).status).toBe(400);
    expect((await s.post(req({ amount: "10", relayerFee: "11" }))).status).toBe(400);
    expect((await s.post(req({ encryptedChange: "0x" + "00".repeat(513) }))).status).toBe(400);
    expect((await s.post(req({ proof: "0x" }))).status).toBe(400);
    expect((await s.post(req({ nullifier: "0x12" as Hex }))).status).toBe(400);
    expect((await s.post(req({ amount: (1n << 128n).toString() }))).status).toBe(400);
    expect(typeof parseWithdraw(req())).toBe("object");
  });

  test("one in flight per nullifier", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ simulate: async () => (await gate, { ok: true }) });
    const first = s.post(req());
    await Bun.sleep(5);
    expect((await s.post(req())).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  test("rate limited per IP; 503 when not configured", async () => {
    const s = setup({}, { ipLimiter: new RateLimiter(1, 60_000) });
    expect((await s.post(req({ nullifier: word(20) }))).status).toBe(200);
    expect((await s.post(req({ nullifier: word(21) }))).status).toBe(429);
    const off = setup({}, { withdraw: undefined });
    expect((await off.post(req())).status).toBe(503);
  });

  test("RELAYER_WITHDRAW_MIN_FEES parsing: unlisted assets are not relayed, a listed 0 still means at least 1", () => {
    const f = parseMinFees(`${ASSET}:25, ${POOL}:0`);
    expect(f(ASSET)).toBe(25n);
    expect(f(POOL)).toBe(1n);
    expect(f(DEST)).toBeUndefined();
    expect(parseMinFees(undefined)(ASSET)).toBeUndefined();
    expect(() => parseMinFees("nope:1")).toThrow();
  });
});

// Audit M-8: the relayer accepted amount 0 and fee 0 and the shipped env left RELAYER_WITHDRAW_MIN_FEES empty, so
// every asset was free. An attacker withdrew 0 (keeping the whole value as change) and repeated, limited only by
// 20 requests a minute per IP, and a new IP (any address of their IPv6 /64) reset the limit.
describe("audit M-8: no free withdraws", () => {
  test("PoC: 21 zero-amount / zero-fee withdraws are all refused before any chain call", async () => {
    let reads = 0;
    const s = setup({ minFee: () => 0n, nullifierSpent: async () => (reads++, false) });
    // a fresh IPv6 address each time, all in one /64: refused, and the 21st hits the shared per-/64 limit
    for (let i = 0; i < 21; i++) {
      const r = await s.post(req({ amount: "0", relayerFee: "0", nullifier: word(100 + i) }), `2001:db8:1:2::${(i + 1).toString(16)}`);
      expect(r.status).toBe(i < 20 ? 400 : 429);
    }
    const zeroFee = await s.post(req({ amount: "1000", relayerFee: "0", nullifier: word(200) }));
    expect(zeroFee.status).toBe(400);
    expect(((await zeroFee.json()) as any).error).toContain("relayerFee must be a positive integer");
    expect(((await (await s.post(req({ amount: "0", relayerFee: "0" }))).json()) as any).error).toContain("pub.amount must be a positive integer");
    expect(reads).toBe(0);
    expect(s.sent).toHaveLength(0);
  });

  test("an asset without a configured fee is not relayed (fail closed)", async () => {
    const s = setup({ minFee: () => undefined });
    const r = await s.post(req());
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain("not relayed");
  });

  test("blank fee tables: a startup error on mainnet; local/testnet fall back to non-zero defaults per deployment asset", () => {
    const dep = { usdg: ASSET, stocks: { TSLA: { token: DEST } } };
    expect(() => relayerTables({}, "mainnet", dep)).toThrow(/RELAYER_WITHDRAW_MIN_FEES must be set on mainnet/);
    expect(() => relayerTables({ RELAYER_WITHDRAW_MIN_FEES: `${ASSET}:1` }, "mainnet", dep)).toThrow(/RELAYER_CLAIM_MIN_RAW must be set on mainnet/);
    const t = relayerTables({}, "testnet", dep);
    expect(t.minFee(ASSET)).toBe(250_000n);
    expect(t.minFee(DEST)).toBe(10n ** 15n);
    expect(t.minFee(POOL)).toBeUndefined();
    expect(t.claimMin(ASSET)).toBe(1_000_000n);
    const m = relayerTables({ RELAYER_WITHDRAW_MIN_FEES: `${ASSET}:7`, RELAYER_CLAIM_MIN_RAW: `${ASSET}:9` }, "mainnet", dep);
    expect(m.minFee(ASSET)).toBe(7n);
    expect(m.minFee(DEST)).toBeUndefined();
    expect(m.claimMin(ASSET)).toBe(9n);
  });

  test("the shipped mainnet env lists a non-zero fee and claim minimum for USDG and every Stock Token", async () => {
    const env = await Bun.file(`${import.meta.dir}/../../scripts/server/env.example`).text();
    const dep = (await Bun.file(`${import.meta.dir}/../../deployments/4663.json`).json()) as { usdg: string; stocks: Record<string, { token: string }> };
    const line = (k: string) => env.split("\n").find((l) => l.startsWith(`${k}=`))!.slice(k.length + 1);
    const t = relayerTables({ RELAYER_WITHDRAW_MIN_FEES: line("RELAYER_WITHDRAW_MIN_FEES"), RELAYER_CLAIM_MIN_RAW: line("RELAYER_CLAIM_MIN_RAW") }, "mainnet", dep);
    for (const a of [dep.usdg, ...Object.values(dep.stocks).map((s) => s.token)] as Address[]) {
      expect(t.minFee(a)! > 1n).toBe(true);
      expect(t.claimMin(a)! > 1n).toBe(true);
    }
  });

  test("rate limit by IPv6 /64: a new address in the same /64 shares the limit; another /64 does not", async () => {
    const s = setup({}, { ipLimiter: new RateLimiter(2, 60_000) });
    expect((await s.post(req({ nullifier: word(30) }), "2001:db8:1:2::1")).status).toBe(200);
    expect((await s.post(req({ nullifier: word(31) }), "2001:db8:1:2:ffff:ffff:ffff:fffe")).status).toBe(200);
    expect((await s.post(req({ nullifier: word(32) }), "2001:0db8:0001:0002:abcd::9")).status).toBe(429);
    expect((await s.post(req({ nullifier: word(33) }), "2001:db8:1:3::1")).status).toBe(200);
  });

  test("ipKey", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("[2001:DB8:0:0:1::1]")).toBe("2001:db8:0:0::/64");
    expect(ipKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("unknown")).toBe("unknown");
  });
});

describe("relayer nonce manager", () => {
  test("concurrent sends get distinct consecutive nonces; a failed send frees its nonce", async () => {
    let chainPending = 7;
    const used: number[] = [];
    const nm = new NonceManager(async () => chainPending);
    const send = (fail = false) => (n: number) =>
      new Promise<number>((res, rej) => setTimeout(() => (fail ? rej(new Error("boom")) : (used.push(n), res(n))), Math.random() * 5));
    const out = await Promise.all([nm.run(send()), nm.run(send()), nm.run(send())]);
    expect(out).toEqual([7, 8, 9]);
    await expect(nm.run(send(true))).rejects.toThrow("boom");
    chainPending = 10; // the node has seen 7, 8, 9
    expect(await nm.run(send())).toBe(10); // the failed nonce 10 is reused, not skipped
    expect(used).toEqual([7, 8, 9, 10]);
  });
});

// Audit SDK lead: private sells go through the relayer (POST /swap, /settle) so the user's wallet never sends them.
describe("POST /swap and /settle", () => {
  const swapBody = (o: Record<string, unknown> = {}) => ({
    proof: "0x" + "ab".repeat(100),
    pub: { root: word(1), nullifier: word(40), changeCommitment: word(3), assetIn: ASSET, amountIn: "1000", relayerFee: "10", assetOut: DEST, minOut: "900", outPartial: word(4), deadline: String(2_000_000_000), ...o },
    maxSlippageBps: 100,
    encryptedChange: "0x",
    encryptedOut: "0x" + "cd".repeat(141),
  });
  function tradeSetup(spent = new Set<string>()) {
    const sent: string[] = [];
    const app = relayerApp({
      chainId: 31337,
      stealthClaims: "0x00000000000000000000000000000000000005c0",
      plynth: [VAULT],
      relayer: "0x0000000000000000000000000000000000000001",
      nonceOf: async () => 0n,
      balanceOf: async () => 0n,
      simulate: async () => ({ ok: true }),
      send: async () => "0x",
      now: () => 1_900_000_000,
      ipOf: () => "1.1.1.1",
      trade: {
        trade: POOL,
        minFee: (a) => (a.toLowerCase() === ASSET.toLowerCase() ? 5n : undefined),
        nullifierSpent: async (n) => spent.has(n),
        isKnownRoot: async (r) => r === word(1),
        simulateSwap: async () => ({ ok: true }),
        sendSwap: async (a) => (sent.push(`swap:${a.pub.nullifier}`), `0x${"5a".repeat(32)}` as Hex),
        simulateSettle: async () => ({ ok: true }),
        sendSettle: async (a) => (sent.push(`settle:${a.nullifier}`), `0x${"5e".repeat(32)}` as Hex),
      },
    });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { post, sent };
  }

  test("valid swap and settle are sent; spent notes, unknown roots and bad shapes are refused", async () => {
    const t = tradeSetup(new Set([word(41)]));
    expect((await t.post("/swap", swapBody())).status).toBe(200);
    expect((await t.post("/swap", swapBody({ nullifier: word(41) }))).status).toBe(409);
    expect((await t.post("/swap", swapBody({ root: word(9), nullifier: word(42) }))).status).toBe(400);
    expect((await t.post("/swap", { ...swapBody(), encryptedOut: "0x" })).status).toBe(400);
    expect((await t.post("/settle", { proof: "0x12", root: word(1), nullifier: word(43), outCommitment: word(5), encryptedOut: "0xab" })).status).toBe(200);
    expect(t.sent).toEqual([`swap:${word(40)}`, `settle:${word(43)}`]);
  });

  test("not configured: 503", async () => {
    const app = relayerApp({ chainId: 1, stealthClaims: POOL, plynth: [], relayer: POOL, nonceOf: async () => 0n, balanceOf: async () => 0n, simulate: async () => ({ ok: true }), send: async () => "0x" });
    expect((await app.request("/swap", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await app.request("/settle", { method: "POST", body: "{}" })).status).toBe(503);
  });
});
