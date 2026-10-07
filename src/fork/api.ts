// Thin client for the dashboard API (REST mirror /v1/...), the relayer and the fork's deployment file.
import type { Address, Hex } from "viem";
import { forkConfig, PROXY } from "./config";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The API answers errors as {error: {code, message}}, the relayer and eligibility as {error: "text"}. */
export function errorText(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string")
    return (e as { message: string }).message;
  return `HTTP ${status}`;
}

async function call<T>(
  base: string,
  path: string,
  init?: RequestInit & { json?: unknown },
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetchFn(`${base}${path}`, {
    ...rest,
    ...(json !== undefined
      ? {
          method: rest.method ?? "POST",
          body: JSON.stringify(json),
          headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
        }
      : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(errorText(body, res.status), res.status);
  return body as T;
}

export const api = {
  get: <T>(path: string) => call<T>(forkConfig().apiBase, path),
  post: <T>(path: string, json: unknown) => call<T>(forkConfig().apiBase, path, { json }),
};
export const relayer = {
  post: <T>(path: string, json: unknown) => call<T>(forkConfig().relayerBase, path, { json }),
};

// ---------------------------------------------------------------- response shapes (backend/app/src/api)

export type Holding = {
  token: Address;
  symbol: string;
  raw: string;
  multiplier: string | null;
  usd: string;
  hold: boolean;
  walletRaw: string;
  claimableRaw: string;
};
export type Overview = {
  totalHoldingsUsd: string;
  allocation: {
    stockTokensUsd: string;
    parkUsd: string;
    availableUsdg: string;
    vaultUsdg: string;
    queuedUsdg: string;
  };
  weekRoundups: string;
  weeklyCap: string;
  mode: Mode;
  holdings: Holding[];
};
export type Mode = "open" | "quiet" | "hidden";
export type Habit = { range: string; unit: string; points: { date: string; savedUsdg: string }[] };
export type ActivityRow = {
  id: string;
  kind: string;
  label: string;
  at: string;
  amount: string;
  unit: string;
  status: string;
  detail: string | null;
  txHash: string;
};
export type Activity = { rows: ActivityRow[]; nextCursor: string | null };
export type Settings = {
  configured: boolean;
  roundTo: number;
  multiplier: number;
  weeklyCap: string;
  fixedTopUp: string;
  mode: Mode;
  mix: { token: Address; symbol: string | null; weightBps: number }[];
};
export type Statements = {
  hidden: boolean;
  ownerPk: Hex | null;
  pool: Address;
  statements: {
    id: string;
    title: string;
    status: string;
    label: string;
    period: { start: string; end: string; fromBlock: string; toBlock: string };
  }[];
};
export type CrowdBooks = {
  now: string;
  window: { start: string; end: string; next: string } | null;
  books: {
    asset: Address;
    symbol: string;
    open: {
      bookId: string;
      accounts: number;
      minCrowd: number;
      usdgTotal: string;
      executeAfter: string | null;
      executedThisWindow?: boolean;
    };
  }[];
};
export type ApiTx = { to: Address; data: Hex; value: string; chainId: number };

// ---------------------------------------------------------------- deployment

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

let dep: Promise<ForkDeployment> | undefined;
/** The fork's deployment file (served by the dev server from backend/app/deployments/fork.json). */
export function deployment(): Promise<ForkDeployment> {
  return (dep ??= call<ForkDeployment>("", PROXY.deployment).catch((e) => {
    dep = undefined;
    throw e;
  }));
}
