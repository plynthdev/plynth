// Client for a Plynth relayer (app/src/relayer): it pays gas for StealthClaims claims (POST /claim), Hidden Vault
// withdraws (POST /withdraw) and private sells / buys / parks (POST /swap, POST /settle) and keeps the fee the user
// signed or proved. Send private trades through it: from your own wallet the transaction names that wallet. No network call happens until a
// function here is called; pass your own fetch to control transport (proxy, Tor, test double).
import type { Address, Hex } from "viem";

/** What a withdraw proof publishes (same shape as the vault's PublicWithdraw). */
export type RelayedWithdraw = {
  proof: Hex;
  pub: {
    root: Hex;
    nullifier: Hex;
    changeCommitment: Hex;
    asset: Address;
    amount: bigint;
    recipient: Address;
    relayerFee: bigint;
    encryptedChange: Hex;
  };
};

/** A ShieldedTrade swap: `proveSwap(...)` output plus the router's slippage guard (bps, at most 500). */
export type RelayedSwap = {
  proof: Hex;
  pub: { root: Hex; nullifier: Hex; changeCommitment: Hex; assetIn: Address; amountIn: bigint; relayerFee: bigint; assetOut: Address; minOut: bigint; outPartial: Hex; deadline: bigint };
  encryptedChange: Hex;
  encryptedOut: Hex;
};
/** A ShieldedTrade settle: `proveSettle(...)` output. */
export type RelayedSettle = { proof: Hex; root: Hex; nullifier: Hex; outCommitment: Hex; encryptedOut: Hex };

/** A StealthClaims claim signed by the stealth key (`signClaim` in `@plynth/sdk/stealth`). */
export type RelayedClaim = { message: { token: Address; stealth: Address; to: Address; raw: bigint; deadline: bigint }; sig: Hex };

export type RelayerHealth = { ok: boolean; chainId: number; stealthClaims: Address; relayer: Address };

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`relayer: ${message}`);
  }
}

const base = (url: string) => url.replace(/\/+$/, "");

/** JSON body for POST /withdraw (bigints as decimal strings). */
export function withdrawRequest(w: RelayedWithdraw) {
  return { proof: w.proof, pub: { ...w.pub, amount: w.pub.amount.toString(), relayerFee: w.pub.relayerFee.toString() } };
}

/** JSON body for POST /swap (bigints as decimal strings). */
export function swapRequest(s: RelayedSwap, maxSlippageBps = 100) {
  const p = s.pub;
  return {
    proof: s.proof,
    pub: { ...p, amountIn: p.amountIn.toString(), relayerFee: p.relayerFee.toString(), minOut: p.minOut.toString(), deadline: p.deadline.toString() },
    maxSlippageBps,
    encryptedChange: s.encryptedChange,
    encryptedOut: s.encryptedOut,
  };
}

/** JSON body for POST /settle. */
export function settleRequest(s: RelayedSettle) {
  return { proof: s.proof, root: s.root, nullifier: s.nullifier, outCommitment: s.outCommitment, encryptedOut: s.encryptedOut };
}

/** JSON body for POST /claim. The nonce is not sent: the relayer checks the signature against the current one. */
export function claimRequest(c: RelayedClaim) {
  const m = c.message;
  return { token: m.token, stealth: m.stealth, to: m.to, raw: m.raw.toString(), deadline: m.deadline.toString(), sig: c.sig };
}

async function post(url: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<Hex> {
  const res = await fetchImpl(`${base(url)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let parsed: { txHash?: Hex; error?: string } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // non-JSON error page
  }
  if (!res.ok || typeof parsed.txHash !== "string") throw new RelayerError(res.status, parsed.error ?? `HTTP ${res.status}`);
  return parsed.txHash;
}

/** Sends a withdraw through a relayer (it pays gas and keeps pub.relayerFee). Returns the tx hash. */
export function submitWithdraw(relayerUrl: string, w: RelayedWithdraw, fetchImpl: typeof fetch = fetch): Promise<Hex> {
  return post(relayerUrl, "/withdraw", withdrawRequest(w), fetchImpl);
}

/**
 * Sends a private sell / buy / park through a relayer (it pays gas and keeps pub.relayerFee, which must be at least
 * its minimum for the input asset). Returns the tx hash. Use this rather than sending `swapTx` yourself.
 */
export function submitSwap(relayerUrl: string, s: RelayedSwap, maxSlippageBps = 100, fetchImpl: typeof fetch = fetch): Promise<Hex> {
  return post(relayerUrl, "/swap", swapRequest(s, maxSlippageBps), fetchImpl);
}

/** Sends a settle (swap output -> v1 note) through a relayer. Returns the tx hash. */
export function submitSettle(relayerUrl: string, s: RelayedSettle, fetchImpl: typeof fetch = fetch): Promise<Hex> {
  return post(relayerUrl, "/settle", settleRequest(s), fetchImpl);
}

/** Sends a signed stealth claim through a relayer. Returns the tx hash. */
export function submitClaim(relayerUrl: string, c: RelayedClaim, fetchImpl: typeof fetch = fetch): Promise<Hex> {
  return post(relayerUrl, "/claim", claimRequest(c), fetchImpl);
}

/** GET /health: the relayer's chain, StealthClaims address and paying account. */
export async function relayerHealth(relayerUrl: string, fetchImpl: typeof fetch = fetch): Promise<RelayerHealth> {
  const res = await fetchImpl(`${base(relayerUrl)}/health`);
  if (!res.ok) throw new RelayerError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as RelayerHealth;
}

/** A relayer bound to one URL (and optionally one fetch). */
export function relayerClient(url: string, fetchImpl: typeof fetch = fetch) {
  return {
    url: base(url),
    health: () => relayerHealth(url, fetchImpl),
    claim: (c: RelayedClaim) => submitClaim(url, c, fetchImpl),
    withdraw: (w: RelayedWithdraw) => submitWithdraw(url, w, fetchImpl),
    swap: (sw: RelayedSwap, maxSlippageBps = 100) => submitSwap(url, sw, maxSlippageBps, fetchImpl),
    settle: (st: RelayedSettle) => submitSettle(url, st, fetchImpl),
  };
}
export { CHAIN_IDS, parseDeployment, publicInfra, type Network, type PlynthDeployment, type PublicInfra } from "../defaults";
