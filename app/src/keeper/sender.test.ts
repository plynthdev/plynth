import { describe, expect, test } from "bun:test";
import { BaseError, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { isNonceError, Sender, TxReverted, type SenderIO } from "./sender";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const TO = "0x00000000000000000000000000000000000000bb" as Address;

class HttpErr extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function fakeIO(o: { failSend?: (n: number) => Error | undefined; reverted?: boolean; chainNonce?: number } = {}) {
  const sent: { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; data: Hex }[] = [];
  let chainNonce = o.chainNonce ?? 7;
  let sendCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const io: SenderIO = {
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }),
    getTransactionCount: async () => chainNonce,
    sendTransaction: async (tx) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight--;
      const err = o.failSend?.(sendCalls);
      sendCalls++;
      if (err) throw err;
      if (tx.nonce !== chainNonce) throw new Error(`nonce too low: expected ${chainNonce}`);
      chainNonce++;
      sent.push({ nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, data: tx.data });
      return `0x${tx.nonce.toString(16).padStart(64, "0")}` as Hash;
    },
    waitForTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: o.reverted ? "reverted" : "success", logs: [] }) as unknown as TransactionReceipt,
  };
  return { io, sent, setChainNonce: (n: number) => (chainNonce = n), stats: () => ({ sendCalls, maxInFlight }) };
}

const noSleep = async () => {};

describe("sender", () => {
  test("gas = estimate + 20%, EIP-1559 fees from the node", async () => {
    const f = fakeIO();
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await s.send(TO, "0x01");
    expect(f.sent[0]!.gas).toBe(120_000n);
    expect(f.sent[0]!.maxFeePerGas).toBe(30n);
    expect(f.sent[0]!.maxPriorityFeePerGas).toBe(2n);
  });

  test("nonce manager: concurrent sends are serialised with consecutive nonces", async () => {
    const f = fakeIO({ chainNonce: 7 });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await Promise.all([1, 2, 3, 4, 5].map((i) => s.send(TO, `0x0${i}` as Hex)));
    expect(f.sent.map((x) => x.nonce)).toEqual([7, 8, 9, 10, 11]);
    expect(f.sent.map((x) => x.data)).toEqual(["0x01", "0x02", "0x03", "0x04", "0x05"]);
    expect(f.stats().maxInFlight).toBe(1);
  });

  test("retries with backoff on 429 / 5xx", async () => {
    const f = fakeIO({ failSend: (n) => (n < 2 ? new HttpErr(n === 0 ? 429 : 503) : undefined) });
    const naps: number[] = [];
    const s = new Sender(f.io, ME, { sleep: async (ms) => void naps.push(ms) });
    await s.send(TO, "0x01");
    expect(f.sent).toHaveLength(1);
    expect(naps).toHaveLength(2);
  });

  test("a stale nonce (another sender used it) is resynced from the node", async () => {
    const f = fakeIO({ chainNonce: 0 });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await s.send(TO, "0x01");
    f.setChainNonce(5); // someone else sent 4 txs with our key
    await s.send(TO, "0x02");
    expect(f.sent.map((x) => x.nonce)).toEqual([0, 5]);
  });

  test("a mined revert throws TxReverted and is not retried", async () => {
    const f = fakeIO({ reverted: true });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await expect(s.send(TO, "0x01", "accrue")).rejects.toBeInstanceOf(TxReverted);
    expect(f.stats().sendCalls).toBe(1);
  });

  test("other errors are thrown at once; the queue keeps working afterwards", async () => {
    const f = fakeIO({ failSend: (n) => (n === 0 ? new Error("insufficient funds") : undefined) });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await expect(s.send(TO, "0x01")).rejects.toThrow(/insufficient funds/);
    await s.send(TO, "0x02");
    expect(f.sent.map((x) => x.data)).toEqual(["0x02"]);
  });

  test("gives up after maxAttempts", async () => {
    const f = fakeIO({ failSend: () => new HttpErr(429) });
    const s = new Sender(f.io, ME, { sleep: noSleep, maxAttempts: 3 });
    await expect(s.send(TO, "0x01")).rejects.toThrow(/429/);
    expect(f.stats().sendCalls).toBe(3);
  });

  test("isNonceError recognises node wording through viem error causes", () => {
    expect(isNonceError(new BaseError("x", { cause: new Error("nonce too low: next nonce 5") }))).toBe(true);
    expect(isNonceError(new Error("already known"))).toBe(true);
    expect(isNonceError(new Error("execution reverted"))).toBe(false);
  });
});
