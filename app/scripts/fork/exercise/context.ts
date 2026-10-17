// Shared state for the exercise areas: the deployment, the named actors, ABIs, small helpers and what one area
// hands to the next (treasury addresses, notes, books).
import { getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { devAccount, PATHS, PORTS, ROLE, type ForkDeployment } from "../lib";
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
export type ActorName = keyof typeof ACTORS | "owner";

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
  // OWNER: on the beta stack a 2-of-3 Safe stand-in (setup.ts), acted as by anvil impersonation (a JSON-RPC account:
  // viem sends eth_sendTransaction from it); elsewhere dev account 0. MainnetBeta makes OWNER the template and
  // insurance committee too.
  const ownerAddr = typeof dep.owner === "string" ? getAddress(dep.owner) : undefined;
  A.owner = (dep.beta && ownerAddr && ownerAddr !== A.deployer.address ? { address: ownerAddr, type: "json-rpc" } : A.deployer) as HDAccount;
  if (dep.beta) A.committee = A.owner;
  for (const [n, a] of Object.entries(A)) if (!r.names.has(a.address.toLowerCase())) r.names.set(a.address.toLowerCase(), n);
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

/**
 * v2 Valuer market calendar (on in MainnetBeta): prices hold from Friday 20:00 to Monday 01:00 UTC and on closed
 * days, so new risk (perp opens, desk buys) is refused then. Steps that need an open market call this after a warp:
 * if the market is closed it moves chain time to the next open hour. No-op on a stack without the calendar.
 */
export async function toMarketOpen(x: Ctx): Promise<void> {
  const v = x.addr("valuer");
  const V = abiOf("Valuer");
  if (!(await x.r.read<boolean>(v, V, "marketClosed", []))) return;
  await x.r.check("market closed by the v2 Valuer calendar: move to the next open hour", async () => {
    let t = await x.r.now();
    while (await x.r.read<boolean>(v, V, "isClosedAt", [t])) t += 3600n;
    await x.r.warpTo(t + 60n);
    expect(!(await x.r.read<boolean>(v, V, "marketClosed", [])), "still closed");
    return `chain time ${t + 60n}`;
  });
}

/**
 * Why `tokens` cannot be priced now because the fork was taken during a market closure: the fork block lies inside the
 * Valuer's closed span (its feeds are frozen at the last close) and one of the tokens is on hold at the current chain
 * time (market closed again, or the frozen feeds are past their staleness). undefined when the market is usable, or
 * when the fork was taken while the market was open (a hold then is a real finding).
 */
export async function closedMarketReason(x: Ctx, tokens: Address[]): Promise<string | undefined> {
  const v = x.addr("valuer");
  const V = abiOf("Valuer");
  const forkTs = (await x.r.pub.getBlock({ blockNumber: BigInt(readFileSync(PATHS.forkBlock, "utf8").trim()) })).timestamp;
  if (!(await x.r.read<boolean>(v, V, "isClosedAt", [forkTs]))) return undefined;
  for (const t of tokens) {
    let hold = true;
    try {
      hold = (await x.r.read<{ hold: boolean }>(v, V, "quote", [t])).hold;
    } catch {
      hold = true;
    }
    if (hold) return `weekend fork: the fork block (${new Date(Number(forkTs) * 1000).toISOString()}) is inside a market closure and ${x.r.who(t)} is on hold at chain time ${await x.r.now()} (closed again, or its frozen feed is past the staleness bound)`;
  }
  return undefined;
}

/** The fork block lies inside the Valuer's closed span (feeds frozen at the last close). */
export async function forkInClosure(x: Ctx): Promise<{ closed: boolean; at: bigint }> {
  const at = (await x.r.pub.getBlock({ blockNumber: BigInt(readFileSync(PATHS.forkBlock, "utf8").trim()) })).timestamp;
  return { closed: await x.r.read<boolean>(x.addr("valuer"), abiOf("Valuer"), "isClosedAt", [at]), at };
}

/**
 * Why the treasury could not reach its policy bands because the fork was taken during a market closure: the equity
 * desk's rebalance stayed partial (`x.state.weekendUnfilled`, names whose real pools trade further from their frozen
 * feeds than the guard's slippage even for a minimum piece). undefined otherwise.
 */
export async function weekendBookReason(x: Ctx): Promise<string | undefined> {
  const names = x.state.weekendUnfilled as string[] | undefined;
  if (!names?.length) return undefined;
  const f = await forkInClosure(x);
  if (!f.closed) return undefined;
  return `weekend fork: the fork block (${new Date(Number(f.at) * 1000).toISOString()}) is inside a market closure; the pools of ${names.join(", ")} trade further from their frozen feeds than the guard's slippage, so the equity desk could not reach its band and this step depends on it`;
}
