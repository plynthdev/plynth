// Shared state for the exercise areas: the deployment, the named actors, ABIs, small helpers and what one area
// hands to the next (treasury addresses, notes, books).
import { getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { devAccount, PORTS, ROLE, type ForkDeployment } from "../lib";
import { abiOf, expect, Recorder } from "./core";

/** Exercise actors: anvil's ten defaults by role, then savers, their spending wallets, LPs and traders. */
export const ACTORS = {
  deployer: ROLE.deployer,
  keeper: ROLE.keeper,
  attester: ROLE.attester,
  controller: ROLE.controller,
  cashDesk: ROLE.cash,
  equityDesk: ROLE.equity,
  hedgeDesk: ROLE.hedge,
  basisDesk: ROLE.basis,
  committee: ROLE.committee,
  relayer: ROLE.relayer,
  open: 10, // Open saver
  quiet: 11, // Quiet saver (stealth delivery)
  hidden: 12, // Hidden saver (shielded notes)
  fourth: 13, // joins, then is revoked and exits
  slipA: 14, // three savers in a book that hits the slippage guard
  slipB: 15,
  slipC: 16,
  wOpen: 17, // linked spending wallets
  wQuiet: 18,
  wHidden: 19,
  wFourth: 20,
  saver: 21, // no mix: keeps pending (top-ups, weekly cap, withdraw from pending)
  wSaver: 22,
  lp: 23, // perp LP
  longT: 24, // perp traders
  shortT: 25,
  liquidator: 26,
  operator: 27, // trade-only operator
  staker: 28, // PLTH staker and template author
  board2: 29, // board of the marketplace treasury
  wSlipA: 30,
  wSlipB: 31,
  wSlipC: 32,
  outsider: 33, // never attested
  shielder: 34, // Hidden Vault direct depositor
  merchant: 35, // receives spends
  trader2: 36,
} as const;
export type ActorName = keyof typeof ACTORS;

export const U = 1_000_000n; // USDG base units
export const E18 = 10n ** 18n;
export const HOUR = 3600n;
export const DAY = 86_400n;

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export type Ctx = {
  r: Recorder;
  dep: ForkDeployment;
  A: Record<ActorName, HDAccount>;
  addr: (key: string) => Address;
  token: (sym: string) => Address;
  abi: (name: string) => Abi;
  /** Cross-area hand-offs. */
  state: Record<string, any>;
  /** Notes for the report (skips, environment). */
  notes: string[];
  /** Diagnosis per failed step key "area/step" when the run knows the cause. */
  diagnosis: Record<string, string>;
};

export function makeCtx(dep: ForkDeployment, r: Recorder): Ctx {
  const A = Object.fromEntries(Object.entries(ACTORS).map(([n, i]) => [n, devAccount(i)])) as Record<ActorName, HDAccount>;
  for (const [n, a] of Object.entries(A)) r.names.set(a.address.toLowerCase(), n);
  for (const [k, v] of Object.entries(dep)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !r.names.has(v.toLowerCase())) r.names.set(v.toLowerCase(), k);
  for (const [sym, s] of Object.entries(dep.stocks)) r.names.set(s.token.toLowerCase(), sym);
  return {
    r,
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
    state: {},
    notes: [],
    diagnosis: {},
  };
}

// ---------------------------------------------------------------- helpers

export const usdgOf = (x: Ctx, who: Address) => x.r.read<bigint>(x.addr("usdg"), erc20Abi, "balanceOf", [who]);
export const balanceOf = (x: Ctx, token: Address, who: Address) => x.r.read<bigint>(token, erc20Abi, "balanceOf", [who]);

export async function approve(x: Ctx, step: string, from: HDAccount, token: Address, spender: Address, amount: bigint) {
  return x.r.send(step, from, { address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }, async () => {
    const a = await x.r.read<bigint>(token, erc20Abi, "allowance", [from.address, spender]);
    expect(a === amount, `allowance ${a} != ${amount}`);
    return `allowance ${x.r.who(spender)} = ${amount}`;
  });
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

/** Logs of `eventName` from `address` since `fromBlock`, decoded with the contract's ABI. */
export async function events(x: Ctx, address: Address, contract: string, eventName: string, fromBlock: bigint, args?: Record<string, unknown>) {
  return x.r.pub.getContractEvents({ address, abi: abiOf(contract), eventName, fromBlock, toBlock: "latest", ...(args ? { args } : {}) } as never) as Promise<{ args: Record<string, any>; transactionHash: Hex; blockNumber: bigint; logIndex: number }[]>;
}

export const fmtUsd = (raw: bigint, dec = 6) => {
  const s = (raw < 0n ? -raw : raw).toString().padStart(dec + 1, "0");
  return `${raw < 0n ? "-" : ""}${s.slice(0, -dec)}.${s.slice(-dec, -dec + 2)}`;
};
