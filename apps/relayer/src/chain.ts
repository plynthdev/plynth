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

/** "0xasset:raw,0xasset:raw" -> per-asset minimum fee (RELAYER_WITHDRAW_MIN_FEES); anything unlisted is free. */
export function parseMinFees(env: string | undefined): (asset: Address) => bigint {
  const m = new Map<string, bigint>();
  for (const part of (env ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [a, v] = part.split(":");
    if (!a || !v || !/^0x[0-9a-fA-F]{40}$/.test(a) || !/^[0-9]+$/.test(v)) throw new Error(`bad RELAYER_WITHDRAW_MIN_FEES entry: ${part}`);
    m.set(a.toLowerCase(), BigInt(v));
  }
  return (asset) => m.get(asset.toLowerCase()) ?? 0n;
}

export function withdrawDeps(o: { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain; pool: Address; minFee: (a: Address) => bigint }): WithdrawDeps {
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
      const hash = await o.wallet.writeContract({ account: o.account, chain: o.chain, address: o.pool, abi: shieldedPoolAbi, functionName: "withdraw", args: args(w) });
      const r = await o.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`withdraw ${hash} reverted on-chain`);
      return hash;
    },
  };
}

export function chainDeps(o: { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain; stealthClaims: Address; plynth: Iterable<string> }): RelayerDeps {
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
      const hash = await o.wallet.writeContract({ account: o.account, chain: o.chain, address: o.stealthClaims, abi: stealthClaimsAbi, functionName: "claim", args: args(a) });
      const r = await o.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`claim ${hash} reverted on-chain`);
      return hash;
    },
  };
}
