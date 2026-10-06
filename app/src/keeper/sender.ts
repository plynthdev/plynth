// Transaction sending: one queue per keeper (a nonce manager that serialises sends), gas = estimate + 20%,
// EIP-1559 fees from the node, retries with jittered backoff on rate limits / server errors, and a nonce
// resync when the node says our nonce is stale.
//
// Never a second transaction for one send: the transaction is signed locally first, so its hash is known before
// it reaches any node. Until the broadcast, everything may be retried (nothing left this process). From the
// first broadcast that may have reached a node (it succeeded, or timed out / 5xx'd), only the SAME signed bytes
// are resent and only that hash is waited for; a 429 or timeout while broadcasting or polling never leads to a new
// transaction, and a hash that never mines ends in TxUnconfirmed (the job's next pass decides, with its own
// on-chain checks). The one re-sign is provably safe: a "nonce too low" on a broadcast that no earlier attempt of
// these bytes can have reached (only 429s before it) means another transaction took the nonce, so ours never
// left; the send starts over with a fresh nonce.
import { backoffDelay, isBackoffError, sleep as realSleep } from "@/indexer";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, keccak256, type Abi, type Address, type Hash, type Hex, type LocalAccount, type PublicClient, type TransactionReceipt } from "viem";

export type UnsignedTx = {
  to: Address;
  data: Hex;
  gas: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/** The subset of viem public + wallet clients the sender uses (tests pass a fake). */
export type SenderIO = {
  estimateGas(a: { account: Address; to: Address; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  getTransactionCount(a: { address: Address; blockTag: "pending" | "latest" }): Promise<number>;
  /** Signs locally (no network): the serialized transaction, whose keccak256 is its hash. */
  signTransaction(tx: UnsignedTx): Promise<Hex>;
  sendRawTransaction(a: { serializedTransaction: Hex }): Promise<Hash>;
  /** The receipt, or null while the transaction is not mined. */
  getTransactionReceipt(a: { hash: Hash }): Promise<TransactionReceipt | null>;
};

/** SenderIO over a viem public client and a local account (signs in-process; the key never leaves it). */
export function viemSenderIO(pub: PublicClient, account: LocalAccount, chainId: number): SenderIO {
  return {
    estimateGas: (a) => pub.estimateGas(a),
    estimateFeesPerGas: () => pub.estimateFeesPerGas(),
    getTransactionCount: (a) => pub.getTransactionCount(a),
    signTransaction: (tx) => account.signTransaction!({ ...tx, chainId, type: "eip1559" }),
    sendRawTransaction: (a) => pub.sendRawTransaction(a),
    getTransactionReceipt: (a) =>
      pub.getTransactionReceipt(a).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "TransactionReceiptNotFoundError") return null;
        throw e;
      }),
  };
}

export type SenderOptions = {
  /** Gas limit multiplier in bps of the estimate. 12_000 = +20%. */
  gasBufferBps?: bigint;
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Receipt polling interval and how long to wait for one broadcast transaction. */
  pollMs?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class TxReverted extends Error {
  constructor(readonly hash: Hash, readonly label: string) {
    super(`${label}: tx ${hash} reverted`);
  }
}

/** Broadcast, but no receipt within the wait: it may still mine. The sender never sends a substitute. */
export class TxUnconfirmed extends Error {
  constructor(readonly hash: Hash, readonly nonce: number, readonly label: string) {
    super(`${label}: tx ${hash} (nonce ${nonce}) not mined within the wait; not resent`);
  }
}

const NONCE_ERROR = /nonce too low|nonce too high|invalid nonce|already known|replacement transaction underpriced|nonce has already been used/i;

export function isNonceError(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (NONCE_ERROR.test(String(e.details ?? "")) || NONCE_ERROR.test(String(e.shortMessage ?? "")) || NONCE_ERROR.test(String(e.message ?? ""))) return true;
  }
  return false;
}

function chainText(err: unknown): string {
  const out: string[] = [];
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) out.push(String(e.details ?? ""), String(e.shortMessage ?? ""), String(e.message ?? ""));
  return out.join(" ");
}

/** HTTP 429 (or a JSON-RPC rate-limit code): the request was refused before the node looked at it. */
function isRateLimited(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (e.status === 429) return true;
    if (typeof e.code === "number" && (e.code === -32005 || e.code === -32029 || e.code === 429)) return true;
  }
  return false;
}

/** Receipt lookups that mean "not mined yet" rather than a transport failure. */
function isNotFound(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (/could not be found|not found/i.test(String(e.name ?? "") + " " + String(e.shortMessage ?? e.message ?? ""))) return true;
  }
  return false;
}

export class Sender {
  private nonce: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly gasBufferBps: bigint;
  private readonly maxAttempts: number;
  private readonly bo: { baseMs: number; maxMs: number };
  private readonly pollMs: number;
  private readonly waitMs: number;
  private readonly nap: (ms: number) => Promise<void>;
  /** Transactions broadcast (distinct signed transactions, not counting resends of the same bytes). */
  sent = 0;

  constructor(
    private readonly io: SenderIO,
    readonly address: Address,
    opts: SenderOptions = {},
  ) {
    this.gasBufferBps = opts.gasBufferBps ?? 12_000n;
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.bo = { baseMs: opts.baseMs ?? 500, maxMs: opts.maxMs ?? 20_000 };
    this.pollMs = opts.pollMs ?? 1_000;
    this.waitMs = opts.waitMs ?? 120_000;
    this.nap = opts.sleep ?? realSleep;
  }

  /** Runs `fn` after every earlier queued send has finished (success or failure). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Sends one transaction and waits for its receipt. Throws TxReverted if it mined but reverted, TxUnconfirmed if
   * it was broadcast but not mined within the wait (it is never replaced by a second transaction).
   * `minGas`: a floor for the gas limit. Needed when the estimate can be wrong in a way that does not revert, such as
   * a Multicall3 aggregate3 with allowFailure: eth_estimateGas finds the least gas at which the OUTER call succeeds,
   * which is a gas limit at which every inner call runs out of gas and is silently skipped.
   */
  send(to: Address, data: Hex, label = "tx", opts: { minGas?: bigint } = {}): Promise<TransactionReceipt> {
    return this.exclusive(async () => {
      for (let round = 0; ; round++) {
        const { signed, hash, nonce } = await this.sign(to, data, opts);
        const r = await this.broadcastAndWait(signed, hash, nonce, label);
        if (r !== "nonce-taken") return r;
        // Our nonce was mined by another transaction and ours has no receipt: it can never mine. Start over.
        this.nonce = undefined;
        if (round + 1 >= this.maxAttempts) throw new Error(`${label}: nonce kept being taken by other transactions`);
      }
    });
  }

  /** Before anything leaves the process: retry freely (backoff, nonce resync). */
  private async sign(to: Address, data: Hex, opts: { minGas?: bigint }): Promise<{ signed: Hex; hash: Hash; nonce: number }> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.nonce === undefined) this.nonce = await this.io.getTransactionCount({ address: this.address, blockTag: "pending" });
        const est = await this.io.estimateGas({ account: this.address, to, data });
        const buffered = (est * this.gasBufferBps) / 10_000n;
        const gas = opts.minGas !== undefined && opts.minGas > buffered ? opts.minGas : buffered;
        const fees = await this.io.estimateFeesPerGas();
        if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error("node returned no EIP-1559 fees");
        const nonce = this.nonce;
        const signed = await this.io.signTransaction({ to, data, gas, nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
        return { signed, hash: keccak256(signed), nonce };
      } catch (err) {
        const nonceErr = isNonceError(err);
        if (nonceErr) this.nonce = undefined;
        if ((!nonceErr && !isBackoffError(err)) || attempt + 1 >= this.maxAttempts) {
          this.nonce = undefined;
          throw err;
        }
        await this.nap(backoffDelay(attempt, this.bo));
      }
    }
  }

  /** From the first broadcast on: only these bytes are resent and only this hash is awaited. */
  private async broadcastAndWait(signed: Hex, hash: Hash, nonce: number, label: string): Promise<TransactionReceipt | "nonce-taken"> {
    let mayHaveReached = false; // an earlier attempt of these bytes may be on a node
    for (let attempt = 0; ; attempt++) {
      try {
        await this.io.sendRawTransaction({ serializedTransaction: signed });
        break;
      } catch (err) {
        if (isNonceError(err)) {
          // "already known": ours is in. "nonce too low" with nothing of ours possibly out: another tx took the
          // nonce, ours never left, re-sign. Otherwise (an earlier attempt may have reached a node): wait for it.
          if (!mayHaveReached && !/already known/i.test(chainText(err))) return "nonce-taken";
          break;
        }
        if (isBackoffError(err)) {
          if (!isRateLimited(err)) mayHaveReached = true; // a timeout or 5xx: the node may have taken it
          if (attempt + 1 < this.maxAttempts) {
            await this.nap(backoffDelay(attempt, this.bo));
            continue;
          }
          if (!mayHaveReached) {
            this.nonce = undefined;
            throw err; // only rate-limit refusals: nothing was accepted
          }
          break; // it may have reached a node: wait for the hash, never re-sign
        }
        if (!mayHaveReached) {
          this.nonce = undefined; // a definite rejection (e.g. insufficient funds): nothing was accepted
          throw err;
        }
        break;
      }
    }
    this.nonce = nonce + 1;
    this.sent += 1;

    const polls = Math.max(1, Math.ceil(this.waitMs / this.pollMs));
    for (let i = 0; i < polls; i++) {
      const receipt = await this.receipt(hash);
      if (receipt) {
        if (receipt.status !== "success") throw new TxReverted(hash, label);
        return receipt;
      }
      if (i > 0 && i % 10 === 0) await this.io.sendRawTransaction({ serializedTransaction: signed }).catch(() => {}); // keep it in the pool
      await this.nap(this.pollMs);
    }
    this.nonce = undefined; // resync: the pending count tells whether it is still in the pool
    throw new TxUnconfirmed(hash, nonce, label);
  }

  private async receipt(hash: Hash): Promise<TransactionReceipt | null> {
    try {
      return await this.io.getTransactionReceipt({ hash });
    } catch (err) {
      if (isNotFound(err) || isBackoffError(err)) return null; // not mined yet, or a transport blip: poll again
      throw err;
    }
  }

  sendCall(to: Address, abi: Abi, functionName: string, args: readonly unknown[], label?: string, opts: { minGas?: bigint } = {}): Promise<TransactionReceipt> {
    return this.send(to, encodeFunctionData({ abi, functionName, args } as any), label ?? functionName, opts);
  }
}

export type SimResult = { ok: true; result: unknown } | { ok: false; errorName: string; args?: readonly unknown[] | undefined; message: string };

/** The revert name of a viem contract error ("AlreadyAccrued", ...), or undefined if it is not a revert. */
export function revertOf(err: unknown): { errorName: string; args?: readonly unknown[] | undefined } | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return undefined;
  return { errorName: r.data?.errorName ?? r.reason ?? "unknown", args: r.data?.args };
}
