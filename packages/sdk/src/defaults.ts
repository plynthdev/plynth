// Default public addresses per network, taken from @plynth/chain (verified on-chain there; bundled into dist,
// so the published package has no dependency on it). Nothing here touches the network.
import { contracts } from "@plynth/chain";
import type { Address } from "viem";

export type Network = "mainnet" | "testnet";

/** Chain ids: Robinhood Chain mainnet 4663, testnet 46630. */
export const CHAIN_IDS: Readonly<Record<Network, number>> = { mainnet: 4663, testnet: 46630 };

/** Third-party contracts the SDK talks to. Every module also takes these as arguments; these are only defaults. */
export type PublicInfra = {
  chainId: number;
  usdg: Address;
  erc5564Announcer: Address;
  erc6538Registry: Address;
  multicall3: Address;
  permit2: Address;
};

export function publicInfra(network: Network): PublicInfra {
  const c = contracts[network];
  return {
    chainId: CHAIN_IDS[network],
    usdg: c.usdg,
    erc5564Announcer: c.erc5564Announcer,
    erc6538Registry: c.erc6538Registry,
    multicall3: c.multicall3,
    permit2: c.permit2,
  };
}

/**
 * Plynth's own contracts. They have no canonical addresses yet: pass the deployment you use
 * (`deployments/<chainId>.json` from the deploy scripts, or your own). Only fields you use need to be set.
 */
export type PlynthDeployment = {
  chainId: number;
  deployBlock?: bigint;
  usdg?: Address;
  savingsVault?: Address;
  crowdBuy?: Address;
  jitterBeacon?: Address;
  stealthClaims?: Address;
  shieldedPool?: Address;
  shieldedTrade?: Address;
  thresholdVerifier?: Address;
  valuer?: Address;
  erc5564Announcer?: Address;
  erc6538Registry?: Address;
};

const ADDRESS_KEYS = ["usdg", "savingsVault", "crowdBuy", "jitterBeacon", "stealthClaims", "shieldedPool", "shieldedTrade", "thresholdVerifier", "valuer", "erc5564Announcer", "erc6538Registry"] as const;

/** Reads a deployment JSON object (as printed/written by the deploy scripts). Unknown keys are ignored. */
export function parseDeployment(json: Record<string, unknown>): PlynthDeployment {
  const chainId = Number(json.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("deployment: chainId must be a positive integer");
  const d: PlynthDeployment = { chainId };
  if (json.deployBlock !== undefined) d.deployBlock = BigInt(json.deployBlock as string | number);
  for (const k of ADDRESS_KEYS) {
    const v = json[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`deployment: ${k} must be an address`);
    d[k] = v as Address;
  }
  return d;
}
