// Shared context of the testnet exercise areas: the deployment, the keystore actors, the fork's step Recorder
// on chain-id guarded testnet clients, and the persistent state (data hand-offs + scheduled steps).
import { getAddress, type Abi, type Address, type PrivateKeyAccount } from "viem";
import { abiOf, Recorder } from "../../fork/exercise/core";
import { clients, PORTS, role, WALLETS, type Role, type TestnetDeployment } from "../lib";
import { schedule, type ExerciseState, type Scheduled } from "./state";

export const U = 1_000_000n;
export const E18 = 10n ** 18n;
export const HOUR = 3600;

/** The deployment's timers, read from the contracts (deploy-time values: testnet uses short ones, mainnet keeps
 *  1 day / 1 hour / 48 hours / 7 days / 14 days / 24 hours). Never assumed. Seconds. */
export type Timers = { genesis: number; window: number; grace: number; capDelay: number; adapterDelay: number; policyTimelock: number; lpCooldown: number; unbonding: number; insuranceDelay: number };

export async function timers(x: TCtx): Promise<Timers> {
  if (x.data.timers) return x.data.timers as Timers;
  const rd = async (key: string, contract: string, fn: string) => Number(await x.r.read<bigint>(x.addr(key), x.abi(contract), fn));
  const policyImpl = await x.r.read<Address>(x.addr("treasuryFactory"), x.abi("TreasuryFactory"), "policyImpl"); // clones share its TIMELOCK
  const t: Timers = {
    genesis: await rd("crowdBuy", "CrowdBuy", "GENESIS"),
    window: await rd("crowdBuy", "CrowdBuy", "WINDOW"),
    grace: await rd("jitterBeacon", "JitterBeacon", "GRACE"),
    capDelay: await rd("shieldedPool", "ShieldedPool", "CAP_DELAY"),
    adapterDelay: await rd("shieldedTrade", "ShieldedTrade", "ADAPTER_DELAY"),
    policyTimelock: Number(await x.r.read<bigint>(getAddress(policyImpl), x.abi("TreasuryPolicy"), "TIMELOCK")),
    lpCooldown: await rd("perpPool", "PerpPool", "REDEEM_COOLDOWN"),
    unbonding: await rd("staking", "PlinthStaking", "UNBONDING"),
    insuranceDelay: await rd("insurancePool", "ExceptionInsurancePool", "WITHDRAW_DELAY"),
  };
  x.data.timers = t;
  return t;
}

/** 900 -> "15 min", 7200 -> "2 h", 172800 -> "48 h", 604800 -> "7 days". */
export function dur(s: number): string {
  if (s % 86_400 === 0 && s >= 3 * 86_400) return `${s / 86_400} days`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

export type TCtx = {
  r: Recorder;
  dep: TestnetDeployment;
  A: Record<Role, PrivateKeyAccount>;
  addr: (key: string) => Address;
  token: (sym: string) => Address;
  abi: (name: string) => Abi;
  st: ExerciseState;
  data: Record<string, any>;
  notes: string[];
  schedule: (item: Omit<Scheduled, "status" | "area"> & { area?: string }) => Scheduled;
};

export function makeCtx(dep: TestnetDeployment, st: ExerciseState, r?: Recorder): TCtx {
  const rec = r ?? new Recorder(new Map(), [], clients() as never);
  rec.steps = st.steps;
  const A = Object.fromEntries((Object.keys(WALLETS) as Role[]).map((n) => [n, role(n)])) as Record<Role, PrivateKeyAccount>;
  for (const [n, a] of Object.entries(A)) rec.names.set(a.address.toLowerCase(), n);
  for (const [k, v] of Object.entries(dep)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !rec.names.has(v.toLowerCase())) rec.names.set(v.toLowerCase(), k);
  for (const [sym, s] of Object.entries(dep.stocks)) rec.names.set(s.token.toLowerCase(), sym);
  const x: TCtx = {
    r: rec,
    dep,
    A,
    addr: (key) => {
      const v = dep[key];
      if (typeof v !== "string") throw new Error(`deployment has no ${key}`);
      return getAddress(v);
    },
    token: (sym) => {
      const s = dep.stocks[sym];
      if (!s) throw new Error(`no stock ${sym}`);
      return getAddress(s.token);
    },
    abi: abiOf,
    st,
    data: st.data,
    notes: st.notes,
    schedule: (item) => schedule(st, { area: item.area ?? rec.area, ...item }),
  };
  return x;
}

export async function api<T = any>(path: string, init?: RequestInit & { port?: number }): Promise<{ status: number; body: T }> {
  const port = init?.port ?? PORTS.api;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

/** Chain time (latest block timestamp), unix seconds. */
export async function chainNow(x: TCtx): Promise<number> {
  return Number(await x.r.now());
}

/**
 * Logs of `eventName` since `fromBlock`, in chunks the public RPC accepts (it refuses very wide ranges).
 */
export async function events(x: TCtx, address: Address, contract: string, eventName: string, fromBlock: bigint, args?: Record<string, unknown>) {
  // The public RPC is load-balanced: right after a receipt, the node answering may not have that block yet
  // (2026-10-07: a Deposited log "missing" on a lagging node). Wait until it has reached fromBlock.
  let latest = await x.r.pub.getBlockNumber();
  for (let i = 0; latest < fromBlock && i < 30; i++) {
    await Bun.sleep(1000);
    latest = await x.r.pub.getBlockNumber();
  }
  const out: { args: Record<string, any>; transactionHash: `0x${string}`; blockNumber: bigint; logIndex: number }[] = [];
  const CHUNK = 50_000n;
  for (let from = fromBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    const logs = (await x.r.pub.getContractEvents({ address, abi: abiOf(contract), eventName, fromBlock: from, toBlock: to, ...(args ? { args } : {}) } as never)) as unknown as typeof out;
    out.push(...logs);
  }
  return out;
}
