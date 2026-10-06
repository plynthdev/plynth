import { describe, expect, test } from "bun:test";
import { BaseError, hexToString, keccak256, toHex, type Address, type Hex, type TransactionReceipt } from "viem";
import { isNonceError, Sender, TxReverted, TxUnconfirmed, type SenderIO } from "./sender";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const TO = "0x00000000000000000000000000000000000000bb" as Address;

class HttpErr extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

type Tx = { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; data: Hex };

/** A fake node. Signed bytes are the JSON of the tx (so the hash is deterministic); a broadcast with a taken
 *  nonce fails like geth; `mined` holds what the "chain" accepted, in nonce order. */
function fakeIO(o: { failSend?: (n: number) => Error | undefined; failReceipt?: (n: number) => Error | undefined; acceptThenFail?: (n: number) => Error | undefined; reverted?: boolean; chainNonce?: number; neverMine?: boolean } = {}) {
  const sent: Tx[] = [];
  const byHash = new Map<string, Tx>();
  let chainNonce = o.chainNonce ?? 7;
  let sendCalls = 0;
  let receiptCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const io: SenderIO = {
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }),
    getTransactionCount: async () => chainNonce,
    signTransaction: async (tx) => toHex(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    sendRawTransaction: async ({ serializedTransaction }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight--;
      const n = sendCalls++;
      const err = o.failSend?.(n);
      if (err) throw err;
      const hash = keccak256(serializedTransaction);
      if (byHash.has(hash)) throw new Error("already known");
      const j = JSON.parse(hexToString(serializedTransaction));
      const tx: Tx = { nonce: j.nonce, gas: BigInt(j.gas), maxFeePerGas: BigInt(j.maxFeePerGas), maxPriorityFeePerGas: BigInt(j.maxPriorityFeePerGas), data: j.data };
      if (tx.nonce !== chainNonce) throw new Error(`nonce too low: expected ${chainNonce}`);
      chainNonce++;
      sent.push(tx);
      byHash.set(hash, tx);
      const late = o.acceptThenFail?.(n); // the node took it, but the answer never reached us
      if (late) throw late;
      return hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      const err = o.failReceipt?.(receiptCalls++);
      if (err) throw err;
      if (!byHash.has(hash) || o.neverMine) return null;
      return { transactionHash: hash, status: o.reverted ? "reverted" : "success", logs: [] } as unknown as TransactionReceipt;
    },
  };
  return { io, sent, setChainNonce: (n: number) => (chainNonce = n), stats: () => ({ sendCalls, maxInFlight, receiptCalls }) };
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

  test("minGas is a floor: used when the buffered estimate is lower, ignored when higher", async () => {
    const f = fakeIO(); // estimate 100k -> 120k buffered
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await s.send(TO, "0x01", "aggregate3", { minGas: 300_000n });
    await s.send(TO, "0x02", "aggregate3", { minGas: 50_000n });
    expect(f.sent.map((x) => x.gas)).toEqual([300_000n, 120_000n]);
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

  // ------------------------------------------------------------ S13 (security review 2026-10-06)

  test("S13: a 429 on the receipt poll after broadcast never sends a second transaction", async () => {
    const f = fakeIO({ chainNonce: 7, failReceipt: (n) => (n === 0 ? new HttpErr(429) : undefined) });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    await s.send(TO, "0x01", "deliverStealth");
    expect(f.sent.map((x) => x.nonce)).toEqual([7]);
    expect(s.sent).toBe(1);
  });

  test("S13: a send that timed out after the node accepted it is not sent again (already known -> wait for its hash)", async () => {
    const f = fakeIO({ chainNonce: 7, acceptThenFail: (n) => (n === 0 ? new HttpErr(504) : undefined) });
    const s = new Sender(f.io, ME, { sleep: noSleep });
    const r = await s.send(TO, "0x01", "deliverStealth");
    expect(f.sent.map((x) => x.nonce)).toEqual([7]);
    expect(f.stats().sendCalls).toBeGreaterThanOrEqual(2); // the same bytes were resent ("already known")
    expect(r.transactionHash).toBeDefined();
    await s.send(TO, "0x02");
    expect(f.sent.map((x) => x.nonce)).toEqual([7, 8]);
  });

  test("S13: broadcast but never mined within the wait -> TxUnconfirmed, nothing resent with a new nonce", async () => {
    const f = fakeIO({ chainNonce: 7, neverMine: true });
    const s = new Sender(f.io, ME, { sleep: noSleep, pollMs: 1, waitMs: 40 });
    await expect(s.send(TO, "0x01", "deliverStealth")).rejects.toBeInstanceOf(TxUnconfirmed);
    expect(f.sent.map((x) => x.nonce)).toEqual([7]);
  });
});
