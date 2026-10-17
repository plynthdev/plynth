// Review v2 regression tests for the relayer (V2-L17 REL-3, V2-L18 REL-5, V2-L19 ZK-4, API-4 info), from the
// rv2-relayer PoCs, now asserting the safe behaviour.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WaitForTransactionReceiptTimeoutError, type Address, type Hex } from "viem";
import { relayerApp, type TradeDeps, type WithdrawDeps } from "@/relayer/app";
import { NonceManager, relayerTables, sendSigned } from "@/relayer/chain";
import { Economics, SETTLE_GAS, SettleTickets } from "@/relayer/economics";
import { assertPublicDestination, assertPublicUrl, isInternalIp } from "@/lib/outbound";

const ROOT = join(import.meta.dir, "..", "..");
const dep = JSON.parse(readFileSync(join(ROOT, "deployments", "4663.json"), "utf8"));
const envExample = readFileSync(join(ROOT, "scripts", "server", "env.example"), "utf8");
const envVal = (k: string) => envExample.match(new RegExp(`^${k}=(.*)$`, "m"))![1]!;
const mainnetTables = relayerTables({ RELAYER_WITHDRAW_MIN_FEES: envVal("RELAYER_WITHDRAW_MIN_FEES"), RELAYER_CLAIM_MIN_RAW: envVal("RELAYER_CLAIM_MIN_RAW") }, "mainnet", dep);
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

// Gas measured with the real UltraHonk verifiers (forge test_fullFlowWithRealProofs): withdraw 3.92M, transfer 5.09M;
// a swap is at least a transfer.
const GAS = { withdraw: 3_916_885n, swap: 5_092_757n, settle: 3_850_000n };

function setup(o: { gasPrice?: bigint; ethUsd?: number; cap?: bigint } = {}) {
  const sent: string[] = [];
  let gasPrice = o.gasPrice ?? 10_000_000n; // 0.01 gwei
  const economics = new Economics(
    { maxFeePerGasWei: o.cap ?? 100_000_000n, ethUsd: o.ethUsd ?? 4_000, marginBps: 1_000 },
    {
      gasPrice: async () => gasPrice,
      // USDG $1; park shares at 1.02 USDG; anything else unpriced
      valueMicroUsd: async (a, raw) => (a.toLowerCase() === dep.usdg.toLowerCase() ? raw : a.toLowerCase() === dep.parkVault.toLowerCase() ? (raw * 102n) / 100n / 10n ** 12n : undefined),
    },
  );
  const tickets = new SettleTickets();
  const trade: TradeDeps = {
    trade: dep.shieldedTrade,
    minFee: mainnetTables.minFee,
    nullifierSpent: async () => false,
    isKnownRoot: async () => true,
    simulateSwap: async () => ({ ok: true, gas: GAS.swap }),
    sendSwap: async (s) => (sent.push(`swap:${s.pub.assetIn}`), word(0xaa)),
    simulateSettle: async () => ({ ok: true, gas: GAS.settle }),
    sendSettle: async (s) => (sent.push(`settle:${s.nullifier}`), word(0xbb)),
  };
  const withdraw: WithdrawDeps = {
    pool: dep.shieldedPool,
    minFee: mainnetTables.minFee,
    nullifierSpent: async () => false,
    isKnownRoot: async () => true,
    simulate: async () => ({ ok: true, gas: GAS.withdraw }),
    send: async () => (sent.push("withdraw"), word(0xcc)),
  };
  const app = relayerApp({
    chainId: 4663,
    stealthClaims: dep.stealthClaims,
    plynth: [],
    relayer: "0x0000000000000000000000000000000000000009",
    nonceOf: async () => 0n,
    balanceOf: async () => 0n,
    simulate: async () => ({ ok: true }),
    send: async () => word(1),
    trade,
    withdraw,
    economics,
    tickets,
    ipOf: () => "198.51.100.9",
    ipLimiter: undefined,
  } as any);
  return { app, sent, setGas: (g: bigint) => (gasPrice = g), tickets };
}
const post = (app: ReturnType<typeof relayerApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const swapBody = (n: number, assetIn: Address, relayerFee: bigint, amountIn = 100_000_000n) => ({
  proof: "0x12",
  pub: { root: word(1), nullifier: word(n), changeCommitment: word(3), assetIn, amountIn: amountIn.toString(), relayerFee: relayerFee.toString(), assetOut: dep.stocks.AAPL.token, minOut: "1", outPartial: word(4), deadline: "4000000000" },
  maxSlippageBps: 100,
  encryptedChange: "0xab",
  encryptedOut: "0xcd",
});
const settleBody = (n: number, ticket?: string) => ({ proof: "0x12", root: word(1), nullifier: word(n), outCommitment: word(5), encryptedOut: "0xab", ...(ticket ? { ticket } : {}) });

describe("V2-L17 / REL-3: every relayed transaction pays for its gas", () => {
  test("settle without a ticket is refused (it carries no fee); the ticket from a paid swap relays exactly one settle", async () => {
    const { app, sent } = setup();
    expect((await post(app, "/settle", settleBody(77))).status).toBe(402);
    expect(sent).toEqual([]);
    const sw = await post(app, "/swap", swapBody(10, dep.usdg, 1_000_000n));
    expect(sw.status).toBe(200);
    const { settleTicket } = (await sw.json()) as { settleTicket: string };
    expect(typeof settleTicket).toBe("string");
    expect((await post(app, "/settle", settleBody(77, settleTicket))).status).toBe(200);
    expect((await post(app, "/settle", settleBody(78, settleTicket))).status).toBe(402); // single use
    expect((await post(app, "/settle", settleBody(79, settleTicket.replace(/.$/, (c) => (c === "A" ? "B" : "A"))))).status).toBe(402);
    expect(sent.filter((s) => s.startsWith("settle"))).toHaveLength(1);
  });

  test("a buy + settle for the old 0.25 USDG minimum costs more gas than it pays: refused, with the fee that is enough", async () => {
    const { app, sent } = setup();
    const r = await post(app, "/swap", swapBody(11, dep.usdg, 250_000n));
    expect(r.status).toBe(400);
    const err = ((await r.json()) as { error: string }).error;
    expect(err).toContain("a fee of at least");
    const need = BigInt(err.match(/at least (\d+)/)![1]!);
    // swap + prepaid settle at 0.01 gwei, $4000 ETH, +10%
    const cost = ((((GAS.swap + SETTLE_GAS) * 10_000_000n * 4_000_000_000n) / 10n ** 18n) * 11_000n + 9_999n) / 10_000n;
    expect(need).toBe(cost);
    expect(sent).toEqual([]);
    expect((await post(app, "/swap", swapBody(12, dep.usdg, need))).status).toBe(200);
  });

  test("withdraws are priced the same way", async () => {
    const { app, sent } = setup({ gasPrice: 50_000_000n });
    const body = (fee: bigint) => ({ proof: "0x12", pub: { root: word(1), nullifier: word(20 + Number(fee % 7n)), changeCommitment: word(3), asset: dep.usdg, amount: "10000000", recipient: "0x00000000000000000000000000000000000000e1", relayerFee: fee.toString(), encryptedChange: "0xab" } });
    expect((await post(app, "/withdraw", body(250_000n))).status).toBe(400); // 3.9M gas at 0.05 gwei, $4000: ~$0.86
    expect((await post(app, "/withdraw", body(1_000_000n))).status).toBe(200);
    expect(sent).toEqual(["withdraw"]);
  });

  test("nothing is sent while gas is above the cap (swap, withdraw and a prepaid settle)", async () => {
    const { app, sent, setGas, tickets } = setup();
    setGas(200_000_000n);
    expect((await post(app, "/swap", swapBody(13, dep.usdg, 10_000_000n))).status).toBe(503);
    const t = tickets.issue();
    expect((await post(app, "/settle", settleBody(80, t))).status).toBe(503);
    expect(sent).toEqual([]);
    setGas(10_000_000n);
    expect((await post(app, "/settle", settleBody(80, t))).status).toBe(200); // refused before sending: the ticket was kept
  });

  test("an asset with no price is not relayed even if it is in the fee table", async () => {
    const { app, sent } = setup();
    const r = await post(app, "/swap", swapBody(14, dep.stocks.AAPL.token, 10n ** 18n, 10n ** 19n));
    expect(r.status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("V2-L19 / ZK-4: private exits through the relayer", () => {
  test("unpark (assetIn = the park share) is relayed: the share token has a fee-table entry and a price", async () => {
    const { app, sent } = setup();
    expect(mainnetTables.minFee(dep.parkVault)).toBe(250_000_000_000_000_000n);
    const r = await post(app, "/swap", { ...swapBody(15, dep.parkVault, 10n ** 18n, 10n ** 20n), pub: { ...swapBody(15, dep.parkVault, 10n ** 18n, 10n ** 20n).pub, assetOut: dep.usdg } });
    expect(r.status).toBe(200);
    expect(sent).toEqual([`swap:${dep.parkVault}`]);
  });
  test("there is still no relayed private transfer (PublicTransfer has no fee field): documented, not relayed for free", async () => {
    const r = await post(setup().app, "/transfer", {});
    expect(r.status).toBe(404);
  });
});

describe("V2-L18 / REL-5: NonceManager recovers from a dropped transaction", () => {
  test("a broadcast the node dropped: after the gap timeout the next send reuses its nonce, and the gap is alerted", async () => {
    const chainPending = 5;
    let now = 1_000;
    const alerts: string[] = [];
    const nm = new NonceManager(async () => chainPending, { now: () => now, gapResetMs: 30_000, alert: (m) => alerts.push(m) });
    const used: number[] = [];
    await nm.run(async (n) => (used.push(n), "0x1")); // nonce 5 broadcast; the node drops it: pending stays 5
    await nm.run(async (n) => (used.push(n), "0x2")); // straight after: the node may just lag, so 6
    now += 30_000;
    await nm.run(async (n) => (used.push(n), "0x3")); // 30 s later the node still counts 5: the gap is refilled
    expect(used).toEqual([5, 6, 5]);
    expect(alerts.join(" ")).toContain("nonce gap");
  });

  test("reset() makes the next send start from the node's count", async () => {
    let pending = 3;
    const nm = new NonceManager(async () => pending);
    const used: number[] = [];
    await nm.run(async (n) => (used.push(n), "0x1"));
    nm.reset("receipt timeout");
    await nm.run(async (n) => (used.push(n), "0x2"));
    expect(used).toEqual([3, 3]);
    pending = 9;
    await nm.run(async (n) => (used.push(n), "0x3"));
    expect(used).toEqual([3, 3, 9]);
  });

  test("sendSigned: a receipt timeout rebroadcasts the same signed bytes once; a second timeout resets the nonces", async () => {
    const broadcasts: Hex[] = [];
    let waits = 0;
    let landOnWait = 2;
    const pub = {
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        waits++;
        if (waits >= landOnWait) return { status: "success", transactionHash: hash };
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
    } as any;
    const wallet = {
      prepareTransactionRequest: async (r: any) => ({ ...r, maxFeePerGas: 500_000_000n, maxPriorityFeePerGas: 400_000_000n, gas: 21_000n }),
      signTransaction: async (r: any) => `0xsigned${r.nonce}${r.maxFeePerGas}` as Hex,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => (broadcasts.push(serializedTransaction), word(0x77)),
    } as any;
    let pending = 4;
    const nm = new NonceManager(async () => pending);
    const o = { pub, wallet, account: { address: "0x0000000000000000000000000000000000000009" } as any, chain: { id: 1 } as any, maxFeePerGas: 100_000_000n, receiptTimeoutMs: 1 };
    expect(await sendSigned(o, nm, "0x00000000000000000000000000000000000000aa", "0x", "test")).toBe(word(0x77));
    expect(broadcasts).toEqual(["0xsigned4100000000", "0xsigned4100000000"]); // same bytes twice; the fee capped at 0.1 gwei
    waits = 0;
    landOnWait = 99;
    await expect(sendSigned(o, nm, "0x00000000000000000000000000000000000000aa", "0x", "test")).rejects.toBeInstanceOf(WaitForTransactionReceiptTimeoutError);
    const used: number[] = [];
    await nm.run(async (n) => (used.push(n), "0x"));
    expect(used).toEqual([4]); // reset: back to the node's pending count, not 6
  });
});

describe("API-4: outbound address forms (info; unchanged)", () => {
  test("literal forms are all refused", () => {
    for (const u of ["https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://[::ffff:127.0.0.1]/", "https://[::]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://0.0.0.0/", "https://100.64.0.1/", "https://169.254.169.254/", "https://metadata.google.internal/", "https://[::ffff:a9fe:a9fe]/", "https://[64:ff9b::7f00:1]/"]) {
      expect(() => assertPublicUrl(u), u).toThrow();
    }
    expect(isInternalIp("::ffff:7f00:1")).toBe(true);
  });
  test("a trailing-dot name is caught by the send-time DNS check", async () => {
    await expect(assertPublicDestination("https://localhost./", { resolve: async () => ["127.0.0.1"] })).rejects.toThrow();
  });
});
