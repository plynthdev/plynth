import type { Deployment } from "@plynth/indexer";
import { getAddress, type Address } from "viem";

export type ApiStock = { symbol: string; token: Address };

export type ApiDeployment = {
  vault: Address;
  crowd: Address;
  beacon: Address;
  valuer: Address;
  usdg: Address;
  stocks: ApiStock[];
  /** Hidden Vault pool and the block the deployment started at (statements scan from there). */
  shieldedPool?: Address;
  /** Threshold-proof verifier (todo 24) for the same pool. */
  thresholdVerifier?: Address;
  deployBlock: bigint;
  /** TreasuryFactory (todo 14) and the block it was deployed at (treasury log scans start there). */
  treasuryFactory?: Address;
  treasuryFactoryBlock?: bigint;
  /** Hourly receipts (todo 30) and the templates marketplace registry. */
  receipts?: Address;
  templateRegistry?: Address;
};

/** Addresses the API reads, from deployments/<chainid>.json (written by the deploy scripts). */
export function apiDeployment(dep: Deployment | undefined, chainId: number): ApiDeployment {
  if (!dep) throw new Error(`no deployments/${chainId}.json`);
  const need = (k: string): Address => {
    const v = dep[k];
    if (typeof v !== "string") throw new Error(`deployment ${chainId} has no ${k}`);
    return getAddress(v);
  };
  return {
    vault: need("savingsVault"),
    crowd: need("crowdBuy"),
    beacon: need("jitterBeacon"),
    valuer: need("valuer"),
    usdg: need("usdg"),
    stocks: Object.entries(dep.stocks ?? {}).map(([symbol, s]) => ({ symbol, token: getAddress(s.token) })),
    ...(typeof dep.shieldedPool === "string" ? { shieldedPool: getAddress(dep.shieldedPool) } : {}),
    ...(typeof dep.thresholdVerifier === "string" ? { thresholdVerifier: getAddress(dep.thresholdVerifier) } : {}),
    deployBlock: dep.deployBlock !== undefined ? BigInt(dep.deployBlock) : 0n,
    ...(typeof dep.treasuryFactory === "string" ? { treasuryFactory: getAddress(dep.treasuryFactory) } : {}),
    ...(dep.treasuryFactoryBlock !== undefined ? { treasuryFactoryBlock: BigInt(dep.treasuryFactoryBlock as string | number) } : {}),
    ...(typeof dep.receipts === "string" && BigInt(dep.receipts) !== 0n ? { receipts: getAddress(dep.receipts) } : {}),
    ...(typeof dep.templateRegistry === "string" && BigInt(dep.templateRegistry) !== 0n ? { templateRegistry: getAddress(dep.templateRegistry) } : {}),
  };
}

export function stockOf(dep: ApiDeployment, token: string): ApiStock | undefined {
  const t = token.toLowerCase();
  return dep.stocks.find((s) => s.token.toLowerCase() === t);
}
