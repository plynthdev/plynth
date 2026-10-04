// @plynth/sdk/relayer against the real relayer app (app/src/relayer) in-process: the client's request bodies are
// exactly what the server parses, and every error comes back as a RelayerError with the HTTP status.
import { describe, expect, test } from "bun:test";
import { getAddress, type Address, type Hex } from "viem";
import { relayerApp, type ClaimArgs, type WithdrawArgs } from "../../app/src/relayer/app";
import { RelayerError, claimRequest, relayerClient, relayerHealth, submitClaim, submitWithdraw, withdrawRequest, type RelayedWithdraw } from "../src/relayer";
import { signClaim } from "../src/stealth";
import { submitWithdraw as vaultSubmitWithdraw, withdrawRequest as vaultWithdrawRequest } from "../src/vault";

const SC = "0x00000000000000000000000000000000000005c0" as Address;
const POOL = "0x0000000000000000000000000000000000000900" as Address;
const TOKEN = "0x00000000000000000000000000000000000070c1" as Address;
const DEST = "0x000000000000000000000000000000000000de57" as Address;
const STEALTH_KEY = "0x00000000000000000000000000000000000000000000000000000000000057e1" as Hex; // test-key
const NOW = 1_800_000_000;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function server() {
  const claims: ClaimArgs[] = [];
  const withdraws: WithdrawArgs[] = [];
  const app = relayerApp({
    chainId: 31337,
    stealthClaims: SC,
    plynth: [],
    relayer: "0x0000000000000000000000000000000000000001",
    nonceOf: async () => 0n,
    balanceOf: async () => 10n ** 18n,
    simulate: async () => ({ ok: true }),
    send: async (a) => (claims.push(a), `0x${"ab".repeat(32)}` as Hex),
    now: () => NOW,
    withdraw: {
      pool: POOL,
      minFee: () => 5n,
      nullifierSpent: async () => false,
      isKnownRoot: async (r) => r === word(1),
      simulate: async () => ({ ok: true }),
      send: async (a) => (withdraws.push(a), `0x${"ee".repeat(32)}` as Hex),
    },
  });
  // A fetch that never leaves the process: routes the request into the Hono app.
  const fetchImpl = ((url: string, init?: RequestInit) => app.request(new URL(url).pathname, init)) as unknown as typeof fetch;
  return { fetchImpl, claims, withdraws };
}

const withdraw = (o: Partial<RelayedWithdraw["pub"]> = {}): RelayedWithdraw => ({
  proof: "0x1234",
  pub: { root: word(1), nullifier: word(2), changeCommitment: word(3), asset: TOKEN, amount: 1000n, recipient: DEST, relayerFee: 10n, encryptedChange: "0x", ...o },
});

describe("relayer client", () => {
  test("submitClaim: a signed claim is accepted as-is by the relayer and forwarded exactly", async () => {
    const s = server();
    const signed = await signClaim(STEALTH_KEY, 31337, SC, { token: TOKEN, to: DEST, raw: 100n, nonce: 0n, deadline: BigInt(NOW + 600) });
    expect(await submitClaim("http://relayer.test/", signed, s.fetchImpl)).toBe(`0x${"ab".repeat(32)}`);
    expect(s.claims[0]).toMatchObject({ token: getAddress(TOKEN), to: getAddress(DEST), raw: 100n, stealth: signed.message.stealth });
    expect(claimRequest(signed)).not.toHaveProperty("nonce"); // the relayer uses the current on-chain nonce
  });

  test("submitWithdraw: bigints as decimal strings, accepted and forwarded exactly", async () => {
    const s = server();
    expect(await submitWithdraw("http://relayer.test", withdraw(), s.fetchImpl)).toBe(`0x${"ee".repeat(32)}`);
    expect(s.withdraws[0]!.pub).toMatchObject({ amount: 1000n, relayerFee: 10n, recipient: getAddress(DEST) });
    expect(withdrawRequest(withdraw()).pub.amount).toBe("1000");
  });

  test("server refusals become RelayerError with status and the server's reason", async () => {
    const s = server();
    const err = await submitWithdraw("http://relayer.test", withdraw({ relayerFee: 1n }), s.fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(RelayerError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/relayerFee below the minimum/);
    const expired = await signClaim(STEALTH_KEY, 31337, SC, { token: TOKEN, to: DEST, raw: 1n, nonce: 0n, deadline: BigInt(NOW - 1) });
    await expect(submitClaim("http://relayer.test", expired, s.fetchImpl)).rejects.toThrow(/expired/);
    expect(s.withdraws).toHaveLength(0);
    expect(s.claims).toHaveLength(0);
  });

  test("non-JSON error pages and 200s without a txHash are errors too", async () => {
    const html = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const err = await submitWithdraw("http://r", withdraw(), html).catch((e) => e);
    expect(err).toBeInstanceOf(RelayerError);
    expect(err.status).toBe(502);
    const empty = (async () => Response.json({})) as unknown as typeof fetch;
    await expect(submitWithdraw("http://r", withdraw(), empty)).rejects.toThrow(/HTTP 200/);
  });

  test("health and the bound client hit the right paths; trailing slashes are trimmed", async () => {
    const s = server();
    const h = await relayerHealth("http://relayer.test///", s.fetchImpl);
    expect(h).toMatchObject({ ok: true, chainId: 31337, stealthClaims: SC });
    const seen: string[] = [];
    const spy = (async (u: string, i?: RequestInit) => (seen.push(u), s.fetchImpl(u, i))) as unknown as typeof fetch;
    const c = relayerClient("http://relayer.test/", spy);
    expect(c.url).toBe("http://relayer.test");
    await c.health();
    await c.withdraw(withdraw());
    expect(seen).toEqual(["http://relayer.test/health", "http://relayer.test/withdraw"]);
  });

  test("the vault module re-exports the same withdraw client (one implementation)", () => {
    expect(vaultSubmitWithdraw).toBe(submitWithdraw);
    expect(vaultWithdrawRequest).toBe(withdrawRequest);
  });
});
