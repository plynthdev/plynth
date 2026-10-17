// viem-backed RelayerDeps.
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  parseAbi,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { shieldedPoolAbi, shieldedTradeAbi } from "@plynth/sdk/vault";
import type { ClaimArgs, RelayerDeps, SettleArgs, SimOutcome, SwapArgs, TradeDeps, WithdrawArgs, WithdrawDeps } from "./app";

export const stealthClaimsAbi = parseAbi([
  "function claim(address token, address stealth, address to, uint256 raw, uint256 deadline, bytes sig)",
  "function nonces(address stealth) view returns (uint256)",
  "function balanceOf(address token, address stealth) view returns (uint256)",
  "error Expired(uint256 deadline)",
  "error BadSignature()",
  "error BadDestination()",
  "error ZeroAmount()",
  "error InsufficientBalance(uint256 balance, uint256 raw)",
]);

function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) return rev.data?.errorName ?? rev.reason ?? "reverted";
  }
  return null;
}

/** "0xasset:raw,0xasset:raw" -> per-asset table. Throws on a malformed entry, naming `name`. */
export function parseAssetTable(env: string | undefined, name: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const part of (env ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [a, v] = part.split(":");
    if (!a || !v || !/^0x[0-9a-fA-F]{40}$/.test(a) || !/^[0-9]+$/.test(v)) throw new Error(`bad ${name} entry: ${part}`);
    m.set(a.toLowerCase(), BigInt(v));
  }
  return m;
}

/**
 * RELAYER_WITHDRAW_MIN_FEES -> per-asset minimum fee; an unlisted asset is not relayed (undefined) and a listed 0
 * still means at least 1 (the relayer never works for free; audit M-8).
 */
export function parseMinFees(env: string | undefined): (asset: Address) => bigint | undefined {
  const m = parseAssetTable(env, "RELAYER_WITHDRAW_MIN_FEES");
  return (asset) => {
    const v = m.get(asset.toLowerCase());
    return v === undefined ? undefined : v > 0n ? v : 1n;
  };
}

/** Defaults when the variable is blank (local and testnet only): 0.25 USDG, 0.001 of a Stock Token (18 decimals). */
export const DEFAULT_WITHDRAW_FEE = { usdg: 250_000n, stock: 1_000_000_000_000_000n } as const;
/** Smallest relayed Quiet claim when blank: 1 USDG, 0.001 of a Stock Token. */
export const DEFAULT_CLAIM_MIN = { usdg: 1_000_000n, stock: 1_000_000_000_000_000n } as const;

function deploymentAssets(dep: { usdg?: unknown; stocks?: Record<string, { token: string }> | undefined }): { usdg: string[]; stocks: string[] } {
  return { usdg: typeof dep.usdg === "string" ? [dep.usdg] : [], stocks: Object.values(dep.stocks ?? {}).map((s) => s.token) };
}

/**
 * The relayer's fee and minimum tables. A blank variable on mainnet is a startup error (fail closed: a relayer that
 * silently relays for free is how the audit's PoC drained it); on local / testnet it falls back to the defaults
 * above for USDG and every Stock Token of the deployment.
 */
export function relayerTables(
  env: { RELAYER_WITHDRAW_MIN_FEES?: string | undefined; RELAYER_CLAIM_MIN_RAW?: string | undefined },
  chain: "local" | "testnet" | "mainnet",
  dep: { usdg?: unknown; stocks?: Record<string, { token: string }> | undefined },
): { minFee: (asset: Address) => bigint | undefined; claimMin: (token: Address) => bigint | undefined } {
  const assets = deploymentAssets(dep);
  const table = (v: string | undefined, name: string, d: { usdg: bigint; stock: bigint }) => {
    if (v && v.trim()) return parseAssetTable(v, name);
    if (chain === "mainnet") throw new Error(`${name} must be set on mainnet ("0xasset:raw,..."; see scripts/server/env.example)`);
    const m = new Map<string, bigint>();
    for (const a of assets.usdg) m.set(a.toLowerCase(), d.usdg);
    for (const a of assets.stocks) m.set(a.toLowerCase(), d.stock);
    return m;
  };
  const fees = table(env.RELAYER_WITHDRAW_MIN_FEES, "RELAYER_WITHDRAW_MIN_FEES", DEFAULT_WITHDRAW_FEE);
  const mins = table(env.RELAYER_CLAIM_MIN_RAW, "RELAYER_CLAIM_MIN_RAW", DEFAULT_CLAIM_MIN);
  return {
    minFee: (a) => {
      const v = fees.get(a.toLowerCase());
      return v === undefined ? undefined : v > 0n ? v : 1n;
    },
    claimMin: (t) => mins.get(t.toLowerCase()),
  };
}

/**
 * One nonce source for every transaction the relayer signs (claims and withdraws). Concurrent requests used to let
 * viem read the same pending nonce twice: the second send failed or replaced the first. Signing is serialised; the
 * next nonce is max(the node's pending count, last used + 1); a failed send drops the local counter so the next one
 * re-reads the chain (a nonce the failed send never used is reused, not skipped).
 *
 * Review v2 (V2-L18 / REL-5): `last` was never reset after a transaction the node dropped, so every later nonce sat
 * behind the gap until a restart. Now: if the node's pending count has not moved past our last nonce `gapResetMs`
 * after we sent it (a transaction in its mempool is counted, so this means it is gone), the gap is alerted and the
 * next send reuses the node's count, filling it. reset() does the same at once (a receipt timed out after a
 * same-bytes rebroadcast).
 */
export class NonceManager {
  private last: number | undefined;
  private lastAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly pending: () => Promise<number>,
    private readonly opts: { gapResetMs?: number; now?: () => number; alert?: (m: string) => void } = {},
  ) {}

  /** Runs `send(nonce)` with the next nonce, one at a time. */
  async run<T>(send: (nonce: number) => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      const chain = await this.pending();
      const now = (this.opts.now ?? Date.now)();
      if (this.last !== undefined && chain <= this.last && now - this.lastAt >= (this.opts.gapResetMs ?? DEFAULT_NONCE_GAP_RESET_MS)) {
        this.opts.alert?.(`nonce gap: the node counts ${chain} pending, our last send used ${this.last}; reusing ${chain}`);
        this.last = undefined;
      }
      const nonce = this.last === undefined || chain > this.last ? chain : this.last + 1;
      try {
        const r = await send(nonce);
        this.last = nonce;
        this.lastAt = now;
        return r;
      } catch (err) {
        this.last = undefined;
        throw err;
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Forgets the local counter: the next send starts from the node's pending count. */
  reset(reason: string) {
    if (this.last !== undefined) this.opts.alert?.(`nonce reset (${reason}): next send re-reads the node`);
    this.last = undefined;
  }
}

export const DEFAULT_NONCE_GAP_RESET_MS = 30_000;
export const RECEIPT_TIMEOUT_MS = 60_000;

type Signer = { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain; maxFeePerGas?: bigint | undefined; receiptTimeoutMs?: number | undefined };

/**
 * Signs and sends one call with the next nonce, then waits for its receipt. The signed bytes are kept: on a receipt
 * timeout the same bytes (same hash, never a second transaction for the nonce) are broadcast once more; if that does
 * not land either, the nonce manager is reset and the request fails (V2-L18). With `maxFeePerGas` set (the relayer's
 * cap, V2-L17) the transaction never bids more than it.
 */
export async function sendSigned(o: Signer, nonces: NonceManager, to: Address, data: Hex, label: string): Promise<Hex> {
  const { hash, raw } = await nonces.run(async (nonce) => {
    const req = (await o.wallet.prepareTransactionRequest({ account: o.account, chain: o.chain, to, data, nonce } as any)) as any;
    if (o.maxFeePerGas !== undefined) {
      if (req.maxFeePerGas === undefined || req.maxFeePerGas > o.maxFeePerGas) req.maxFeePerGas = o.maxFeePerGas;
      if (req.maxPriorityFeePerGas !== undefined && req.maxPriorityFeePerGas > req.maxFeePerGas) req.maxPriorityFeePerGas = req.maxFeePerGas;
    }
    const raw = await o.wallet.signTransaction({ ...req, account: o.account, chain: o.chain });
    const hash = await o.wallet.sendRawTransaction({ serializedTransaction: raw });
    return { hash, raw };
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await o.pub.waitForTransactionReceipt({ hash, timeout: o.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS });
      if (r.status !== "success") throw new Error(`${label} ${hash} reverted on-chain`);
      return hash;
    } catch (err) {
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      if (attempt >= 1) {
        nonces.reset(`${label} ${hash}: no receipt after a rebroadcast`);
        throw err;
      }
      await o.wallet.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined); // already known / mined
    }
  }
}

async function estimate(o: Signer, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<bigint | undefined> {
  try {
    return await o.pub.estimateContractGas({ account: o.account, address, abi, functionName, args } as any);
  } catch {
    return undefined; // the economics check refuses a request it cannot price
  }
}

export function withdrawDeps(o: Signer & { pool: Address; minFee: (a: Address) => bigint | undefined; nonces?: NonceManager }): WithdrawDeps {
  const nonces = o.nonces ?? new NonceManager(() => o.pub.getTransactionCount({ address: o.account.address, blockTag: "pending" }));
  const args = (w: WithdrawArgs) => [w.proof, w.pub] as const;
  return {
    pool: o.pool,
    minFee: o.minFee,
    nullifierSpent: (n) => o.pub.readContract({ address: o.pool, abi: shieldedPoolAbi, functionName: "nullifierSpent", args: [n] }) as Promise<boolean>,
    isKnownRoot: (r) => o.pub.readContract({ address: o.pool, abi: shieldedPoolAbi, functionName: "isKnownRoot", args: [r] }) as Promise<boolean>,
    simulate: async (w): Promise<SimOutcome> => {
      try {
        await o.pub.simulateContract({ account: o.account, address: o.pool, abi: shieldedPoolAbi, functionName: "withdraw", args: args(w) });
        return { ok: true, gas: await estimate(o, o.pool, shieldedPoolAbi as Abi, "withdraw", args(w)) };
      } catch (err) {
        const name = revertName(err);
        if (name) return { ok: false, error: name };
        throw err;
      }
    },
    send: (w) => sendSigned(o, nonces, o.pool, encodeFunctionData({ abi: shieldedPoolAbi, functionName: "withdraw", args: args(w) } as any), "withdraw"),
  };
}

/** ShieldedTrade swap and settle (the pool answers spent/root questions: the trade spends pool notes). */
export function tradeDeps(o: Signer & { trade: Address; pool: Address; minFee: (a: Address) => bigint | undefined; nonces?: NonceManager }): TradeDeps {
  const nonces = o.nonces ?? new NonceManager(() => o.pub.getTransactionCount({ address: o.account.address, blockTag: "pending" }));
  const swapArgs = (s: SwapArgs) => [s.proof, s.pub, s.maxSlippageBps, s.encryptedChange, s.encryptedOut] as const;
  const settleArgs = (s: SettleArgs) => [s.proof, s.root, s.nullifier, s.outCommitment, s.encryptedOut] as const;
  const sim = async (functionName: "swap" | "settle", args: readonly unknown[]): Promise<SimOutcome> => {
    try {
      await o.pub.simulateContract({ account: o.account, address: o.trade, abi: shieldedTradeAbi, functionName, args } as any);
      return { ok: true, gas: await estimate(o, o.trade, shieldedTradeAbi as Abi, functionName, args) };
    } catch (err) {
      const name = revertName(err);
      if (name) return { ok: false, error: name };
      throw err;
    }
  };
  const send = (functionName: "swap" | "settle", args: readonly unknown[]) =>
    sendSigned(o, nonces, o.trade, encodeFunctionData({ abi: shieldedTradeAbi, functionName, args } as any), functionName);
  return {
    trade: o.trade,
    minFee: o.minFee,
    nullifierSpent: (n) => o.pub.readContract({ address: o.pool, abi: shieldedPoolAbi, functionName: "nullifierSpent", args: [n] }) as Promise<boolean>,
    isKnownRoot: (r) => o.pub.readContract({ address: o.pool, abi: shieldedPoolAbi, functionName: "isKnownRoot", args: [r] }) as Promise<boolean>,
    simulateSwap: (s) => sim("swap", swapArgs(s)),
    sendSwap: (s) => send("swap", swapArgs(s)),
    simulateSettle: (s) => sim("settle", settleArgs(s)),
    sendSettle: (s) => send("settle", settleArgs(s)),
  };
}

export function chainDeps(o: Signer & { stealthClaims: Address; plynth: Iterable<string>; nonces?: NonceManager }): RelayerDeps {
  const nonces = o.nonces ?? new NonceManager(() => o.pub.getTransactionCount({ address: o.account.address, blockTag: "pending" }));
  const args = (a: ClaimArgs) => [a.token, a.stealth, a.to, a.raw, a.deadline, a.sig] as const;
  return {
    chainId: o.chain.id,
    stealthClaims: o.stealthClaims,
    plynth: o.plynth,
    relayer: o.account.address,
    nonceOf: (s) => o.pub.readContract({ address: o.stealthClaims, abi: stealthClaimsAbi, functionName: "nonces", args: [s] }) as Promise<bigint>,
    balanceOf: (t, s) => o.pub.readContract({ address: o.stealthClaims, abi: stealthClaimsAbi, functionName: "balanceOf", args: [t, s] }) as Promise<bigint>,
    simulate: async (a): Promise<SimOutcome> => {
      try {
        await o.pub.simulateContract({ account: o.account, address: o.stealthClaims, abi: stealthClaimsAbi, functionName: "claim", args: args(a) });
        return { ok: true };
      } catch (err) {
        if (err instanceof BaseError) {
          const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
          if (rev) return { ok: false, error: rev.data?.errorName ?? rev.reason ?? "reverted" };
        }
        throw err;
      }
    },
    send: (a) => sendSigned(o, nonces, o.stealthClaims, encodeFunctionData({ abi: stealthClaimsAbi, functionName: "claim", args: args(a) }), "claim"),
    nonceStatus: async () => {
      const [latest, pending] = await Promise.all([o.pub.getTransactionCount({ address: o.account.address, blockTag: "latest" }), o.pub.getTransactionCount({ address: o.account.address, blockTag: "pending" })]);
      return { latest, pending };
    },
  };
}

const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)", "function decimals() view returns (uint8)"]);
const erc20DecimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

/**
 * What a fee is worth (V2-L17): USDG (6 decimals) at $1; a Stock Token at its Chainlink feed (the deployment's
 * `stocks[*].feed`); a park share at ShieldedTrade.parkValue (USDG). Anything else has no price and is not relayed.
 */
export function feeValuer(o: {
  pub: PublicClient;
  dep: { usdg?: unknown; stocks?: Record<string, { token: string; feed?: string }> | undefined; parkVault?: unknown };
  trade?: Address | undefined;
}): (asset: Address, raw: bigint) => Promise<bigint | undefined> {
  const usdg = typeof o.dep.usdg === "string" ? o.dep.usdg.toLowerCase() : undefined;
  const park = typeof o.dep.parkVault === "string" ? o.dep.parkVault.toLowerCase() : undefined;
  const feeds = new Map(Object.values(o.dep.stocks ?? {}).filter((s) => s.feed).map((s) => [s.token.toLowerCase(), s.feed as Address]));
  const decimals = new Map<string, number>();
  const dec = async (a: Address, abi: Abi) => {
    const k = a.toLowerCase();
    if (!decimals.has(k)) decimals.set(k, Number(await o.pub.readContract({ address: a, abi, functionName: "decimals" } as any)));
    return decimals.get(k)!;
  };
  return async (asset, raw) => {
    const a = asset.toLowerCase();
    if (a === usdg) return raw;
    if (a === park && o.trade) return (await o.pub.readContract({ address: o.trade, abi: shieldedTradeAbi, functionName: "parkValue", args: [asset, raw] } as any)) as bigint;
    const feed = feeds.get(a);
    if (!feed) return undefined;
    const [, answer] = (await o.pub.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
    if (answer <= 0n) return undefined;
    const [fd, td] = await Promise.all([dec(feed, feedAbi as Abi), dec(asset, erc20DecimalsAbi as Abi)]);
    return (raw * answer * 1_000_000n) / 10n ** BigInt(fd + td);
  };
}
