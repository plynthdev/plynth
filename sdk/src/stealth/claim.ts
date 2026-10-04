// EIP-712 claim for StealthClaims: signed by the stealth key, submitted by anyone (the relayer).
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, TypedDataDomain } from "viem";

export const claimTypes = {
  Claim: [
    { name: "token", type: "address" },
    { name: "stealth", type: "address" },
    { name: "to", type: "address" },
    { name: "raw", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type ClaimMessage = { token: Address; stealth: Address; to: Address; raw: bigint; nonce: bigint; deadline: bigint };

export function claimDomain(chainId: number, stealthClaims: Address): TypedDataDomain {
  return { name: "Plynth StealthClaims", version: "1", chainId, verifyingContract: stealthClaims };
}

/** Signs a claim with the stealth private key. Returns the 65-byte signature. */
export async function signClaim(stealthKey: Hex, chainId: number, stealthClaims: Address, msg: Omit<ClaimMessage, "stealth">): Promise<{ message: ClaimMessage; sig: Hex }> {
  const acct = privateKeyToAccount(stealthKey);
  const message: ClaimMessage = { ...msg, stealth: acct.address };
  const sig = await acct.signTypedData({ domain: claimDomain(chainId, stealthClaims), types: claimTypes, primaryType: "Claim", message });
  return { message, sig };
}
