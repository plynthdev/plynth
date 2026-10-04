// Source 1: self-attestation. The wallet signs an EIP-712 statement that it is not a restricted person.
// Verification goes through a public client when one is given (EOA, ERC-1271 smart accounts and ERC-6492
// counterfactual accounts), otherwise plain ECDSA recovery (EOA only).
import { verifyTypedData, type Address, type Hex, type PublicClient } from "viem";

export const STATEMENT_VERSION = 1;
export const STATEMENT =
  "I am not a person of the United States, the United Kingdom, Canada or Switzerland (not a resident, " +
  "citizen or entity there) and I do not act for one. I understand Stock Tokens are not offered to them.";
/** A self-attestation may be signed for at most a year ahead. */
export const MAX_STATEMENT_TTL_S = 365 * 24 * 3600;

export const selfAttestationTypes = {
  SelfAttestation: [
    { name: "wallet", type: "address" },
    { name: "statement", type: "string" },
    { name: "version", type: "uint32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export function selfAttestationDomain(chainId: number) {
  return { name: "Plynth Eligibility", version: "1", chainId } as const;
}

/** The exact typed data a wallet must sign (frontends call this, then signTypedData). */
export function selfAttestationTypedData(chainId: number, wallet: Address, expiry: bigint) {
  return {
    domain: selfAttestationDomain(chainId),
    types: selfAttestationTypes,
    primaryType: "SelfAttestation" as const,
    message: { wallet, statement: STATEMENT, version: STATEMENT_VERSION, expiry },
  };
}

export type SelfAttestationResult = { ok: true } | { ok: false; reason: "self_attestation_expired" | "self_attestation_invalid" };

export async function checkSelfAttestation(opts: {
  chainId: number;
  wallet: Address;
  expiry: bigint;
  signature: Hex;
  nowS: number;
  pub?: PublicClient;
}): Promise<SelfAttestationResult> {
  const { chainId, wallet, expiry, signature, nowS, pub } = opts;
  if (expiry <= BigInt(nowS)) return { ok: false, reason: "self_attestation_expired" };
  if (expiry > BigInt(nowS + MAX_STATEMENT_TTL_S)) return { ok: false, reason: "self_attestation_invalid" };
  const td = { ...selfAttestationTypedData(chainId, wallet, expiry), address: wallet, signature };
  try {
    const ok = pub ? await pub.verifyTypedData(td) : await verifyTypedData(td);
    return ok ? { ok: true } : { ok: false, reason: "self_attestation_invalid" };
  } catch {
    return { ok: false, reason: "self_attestation_invalid" };
  }
}
