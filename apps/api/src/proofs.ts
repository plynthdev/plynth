// Threshold proofs (Hidden v2). POST /v1/proofs/verify is stateless: it checks one proof for the caller's own
// request (verifier + requestId) through ThresholdVerifier's views and stores nothing. The proof never reveals
// which notes or deposits were counted; see the SDK README for what a verifier learns.
import { verifierNonce, verifyThresholdProof, type ThresholdVerdict } from "@plynth/sdk/statements";
import type { Address, Hex } from "viem";
import { StatementsUnavailable } from "./statements";
import type { Deps } from "./service";

function thresholdVerifierOf(d: Deps): Address {
  if (!d.dep.thresholdVerifier) throw new StatementsUnavailable("no threshold-proof verifier on this deployment");
  return d.dep.thresholdVerifier;
}

/** The verifier_nonce a prover must bind its proof to for (verifier, requestId) on this deployment. */
export function proofNonce(d: Deps, verifier: Address, requestId: Hex) {
  const thresholdVerifier = thresholdVerifierOf(d);
  const nonce = verifierNonce({ chainId: d.chainId, thresholdVerifier, verifier, requestId });
  return { chainId: d.chainId, thresholdVerifier, verifier, requestId, nonce: `0x${nonce.toString(16).padStart(64, "0")}` };
}

export async function verifyThreshold(d: Deps, proof: unknown, verifier: Address, requestId: Hex): Promise<ThresholdVerdict> {
  return verifyThresholdProof(d.pub, proof, { verifier, requestId }, { chainId: d.chainId, thresholdVerifier: thresholdVerifierOf(d) });
}
