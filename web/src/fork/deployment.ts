// Where the dashboard finds the contract addresses of the configured chain.
// - `vite dev`: the dev server serves the chain's deployment file at /__fork/deployment.json, read on every request,
//   so a fork redeploy needs no restart (vite.config.ts).
// - `vite build`: vite.config.ts inlines the same file as __PLYNTH_DEPLOYMENT__, or null when it does not exist yet
//   (mainnet before the beta deploy). The build never fails for a missing file: the dashboard says "not deployed yet".
// Accepted shapes: app/deployments/<chain>.json (what the services read) and the raw MainnetBeta.s.sol output
// app/deployments/4663-beta.json (stocks / perpMarkets may be JSON strings there).
import { isAddress, type Address } from "viem";
import { forkConfig, MAINNET_CHAIN_ID, PROXY } from "./config";

declare const __PLYNTH_DEPLOYMENT__: unknown;

export type ForkDeployment = {
  chainId: number;
  deployBlock: number | string;
  savingsVault: Address;
  crowdBuy: Address;
  usdg: Address;
  eligibilityRegistry: Address;
  erc5564Announcer: Address;
  erc6538Registry: Address;
  stealthClaims: Address;
  shieldedPool: Address;
  shieldedTrade?: Address;
  stocks: Record<string, { token: Address }>;
};

/** Every address the dashboard's actions read. */
export const REQUIRED_ADDRESSES = [
  "savingsVault",
  "crowdBuy",
  "usdg",
  "eligibilityRegistry",
  "erc5564Announcer",
  "erc6538Registry",
  "stealthClaims",
  "shieldedPool",
] as const;

/** The contracts are not deployed on the configured chain (no deployment file in the build or on the dev server). */
export class DeploymentMissing extends Error {
  constructor(readonly chainId: number) {
    super(`Plynth is not deployed on chain ${chainId} yet`);
    this.name = "DeploymentMissing";
  }
}

/** Parses a deployment file for `chainId`; throws on another chain, a fork-mode mainnet file or a missing address. */
export function normalizeDeployment(raw: unknown, chainId: number): ForkDeployment {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("deployment file is not a JSON object");
  const r = raw as Record<string, unknown>;
  const obj = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);
  const d: Record<string, unknown> = { ...r, stocks: obj(r["stocks"]) ?? {} };
  if (r["perpMarkets"] !== undefined) d["perpMarkets"] = obj(r["perpMarkets"]);
  if (Number(d["chainId"]) !== chainId)
    throw new Error(`deployment file is for chain ${String(d["chainId"])}, not ${chainId}`);
  if (chainId === MAINNET_CHAIN_ID && d["fork"] === true)
    throw new Error("deployment file comes from a fork-mode run, not the mainnet deploy");
  for (const k of REQUIRED_ADDRESSES)
    if (typeof d[k] !== "string" || !isAddress(d[k] as string, { strict: false }))
      throw new Error(`deployment file has no ${k} address`);
  if (d["deployBlock"] === undefined) throw new Error("deployment file has no deployBlock");
  return d as unknown as ForkDeployment;
}

/** The file inlined by `vite build`: undefined when not built by vite.config.ts (vitest), null when there was none. */
export function bundledDeployment(): unknown {
  return typeof __PLYNTH_DEPLOYMENT__ === "undefined" ? undefined : __PLYNTH_DEPLOYMENT__;
}

let missing = false;
let dep: Promise<ForkDeployment> | undefined;

/** True once it is known that the configured chain has no deployment (the dashboard shows "not deployed yet"). */
export function deploymentMissing(): boolean {
  return missing || (!import.meta.env.DEV && bundledDeployment() === null);
}

/** Loads the deployment: the dev server's file in `vite dev`, the inlined one in a build. */
export function loadDeployment(opts: {
  dev: boolean;
  chainId: number;
  bundled: unknown;
  fetchFn?: typeof fetch;
}): Promise<ForkDeployment> {
  const { dev, chainId, bundled } = opts;
  if (!dev) {
    if (bundled === null || bundled === undefined) return Promise.reject(new DeploymentMissing(chainId));
    return Promise.resolve().then(() => normalizeDeployment(bundled, chainId));
  }
  return (opts.fetchFn ?? fetch)(PROXY.deployment).then(async (res) => {
    if (res.status === 404) throw new DeploymentMissing(chainId);
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new Error(`deployment file: HTTP ${res.status}`);
    return normalizeDeployment(body, chainId);
  });
}

/** Test hook: forget what is known about the deployment (`missing` forces the "not deployed yet" state). */
export function _resetDeploymentForTests(opts: { missing?: boolean } = {}) {
  missing = opts.missing ?? false;
  dep = undefined;
}

/** The configured chain's deployment, loaded once (a failed load is retried on the next call). */
export function deployment(): Promise<ForkDeployment> {
  return (dep ??= loadDeployment({
    dev: Boolean(import.meta.env.DEV),
    chainId: forkConfig().chainId,
    bundled: bundledDeployment(),
  }).catch((e) => {
    dep = undefined;
    if (e instanceof DeploymentMissing) missing = true;
    throw e;
  }));
}
