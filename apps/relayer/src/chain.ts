// viem-backed RelayerDeps.
import { BaseError, ContractFunctionRevertedError, parseAbi, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import type { ClaimArgs, RelayerDeps, SimOutcome } from "./app";

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
