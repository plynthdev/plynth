// POST /withdraw (Hidden Vault) with stubbed chain reads.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { parseWithdraw, relayerApp, type RelayerDeps, type WithdrawArgs, type WithdrawDeps } from "./app";
import { parseMinFees } from "./chain";
import { RateLimiter } from "./ratelimit";

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
    expect(((await sim.json()) as any).error).toContain("InvalidProof");
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

  test("RELAYER_WITHDRAW_MIN_FEES parsing", () => {
    const f = parseMinFees(`${ASSET}:25, ${POOL}:0`);
    expect(f(ASSET)).toBe(25n);
    expect(f(DEST)).toBe(0n);
    expect(parseMinFees(undefined)(ASSET)).toBe(0n);
    expect(() => parseMinFees("nope:1")).toThrow();
  });
});
