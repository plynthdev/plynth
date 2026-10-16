// viem-backed RelayerDeps.
import { BaseError, ContractFunctionRevertedError, parseAbi, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import { shieldedPoolAbi } from "@plynth/sdk/vault";
import type { ClaimArgs, RelayerDeps, SimOutcome, WithdrawArgs, WithdrawDeps } from "./app";

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
 */
export class NonceManager {
  private last: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly pending: () => Promise<number>) {}

  /** Runs `send(nonce)` with the next nonce, one at a time. */
  async run<T>(send: (nonce: number) => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      const chain = await this.pending();
      const nonce = this.last === undefined || chain > this.last ? chain : this.last + 1;
      try {
        const r = await send(nonce);
        this.last = nonce;
        return r;
      } catch (err) {
        this.last = undefined;
        throw err;
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

export function withdrawDeps(o: { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain; pool: Address; minFee: (a: Address) => bigint | undefined; nonces?: NonceManager }): WithdrawDeps {
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
        return { ok: true };
      } catch (err) {
        const name = revertName(err);
        if (name) return { ok: false, error: name };
        throw err;
      }
    },
    send: async (w) => {
      const hash = await nonces.run((nonce) => o.wallet.writeContract({ account: o.account, chain: o.chain, address: o.pool, abi: shieldedPoolAbi, functionName: "withdraw", args: args(w), nonce }));
      const r = await o.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`withdraw ${hash} reverted on-chain`);
      return hash;
    },
  };
}

export function chainDeps(o: { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain; stealthClaims: Address; plynth: Iterable<string>; nonces?: NonceManager }): RelayerDeps {
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
    send: async (a) => {
      const hash = await nonces.run((nonce) => o.wallet.writeContract({ account: o.account, chain: o.chain, address: o.stealthClaims, abi: stealthClaimsAbi, functionName: "claim", args: args(a), nonce }));
      const r = await o.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`claim ${hash} reverted on-chain`);
      return hash;
    },
  };
}
