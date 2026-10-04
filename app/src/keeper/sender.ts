// Transaction sending: one queue per keeper (a nonce manager that serialises sends), gas = estimate + 20%,
// EIP-1559 fees from the node, retries with jittered backoff on rate limits / server errors, and a nonce
// resync when the node says our nonce is stale.
import { backoffDelay, isBackoffError, sleep as realSleep } from "@/indexer";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Abi, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";

/** The subset of viem public + wallet clients the sender uses (tests pass a fake). */
export type SenderIO = {
  estimateGas(a: { account: Address; to: Address; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  getTransactionCount(a: { address: Address; blockTag: "pending" }): Promise<number>;
  sendTransaction(tx: {
    to: Address;
    data: Hex;
    gas: bigint;
    nonce: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<Hash>;
  waitForTransactionReceipt(a: { hash: Hash }): Promise<TransactionReceipt>;
};

export type SenderOptions = {
  /** Gas limit multiplier in bps of the estimate. 12_000 = +20%. */
  gasBufferBps?: bigint;
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class TxReverted extends Error {
  constructor(readonly hash: Hash, readonly label: string) {
    super(`${label}: tx ${hash} reverted`);
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

export class Sender {
  private nonce: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly gasBufferBps: bigint;
  private readonly maxAttempts: number;
  private readonly bo: { baseMs: number; maxMs: number };
  private readonly nap: (ms: number) => Promise<void>;
  sent = 0;

  constructor(
    private readonly io: SenderIO,
    readonly address: Address,
    opts: SenderOptions = {},
  ) {
    this.gasBufferBps = opts.gasBufferBps ?? 12_000n;
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.bo = { baseMs: opts.baseMs ?? 500, maxMs: opts.maxMs ?? 20_000 };
    this.nap = opts.sleep ?? realSleep;
  }

  /** Runs `fn` after every earlier queued send has finished (success or failure). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Sends one transaction and waits for its receipt. Throws TxReverted if it mined but reverted. */
  send(to: Address, data: Hex, label = "tx"): Promise<TransactionReceipt> {
    return this.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (this.nonce === undefined) this.nonce = await this.io.getTransactionCount({ address: this.address, blockTag: "pending" });
          const est = await this.io.estimateGas({ account: this.address, to, data });
          const gas = (est * this.gasBufferBps) / 10_000n;
          const fees = await this.io.estimateFeesPerGas();
          if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error("node returned no EIP-1559 fees");
          const hash = await this.io.sendTransaction({
            to,
            data,
            gas,
            nonce: this.nonce,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          });
          this.nonce += 1;
          this.sent += 1;
          const receipt = await this.io.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new TxReverted(hash, label);
          return receipt;
        } catch (err) {
          if (err instanceof TxReverted) throw err;
          const nonceErr = isNonceError(err);
          if (nonceErr) this.nonce = undefined; // resync from the node next attempt
          if ((!nonceErr && !isBackoffError(err)) || attempt + 1 >= this.maxAttempts) {
            this.nonce = undefined;
            throw err;
          }
          await this.nap(backoffDelay(attempt, this.bo));
        }
      }
    });
  }

  sendCall(to: Address, abi: Abi, functionName: string, args: readonly unknown[], label?: string): Promise<TransactionReceipt> {
    return this.send(to, encodeFunctionData({ abi, functionName, args } as any), label ?? functionName);
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
