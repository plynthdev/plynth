// Crowd-buy engine: savers pool small USDG buys of one Stock Token into one swap (CrowdBuy + SavingsVault).
// Unsigned transaction builders, pure helpers that mirror the contract's arithmetic, and read helpers that
// take a viem PublicClient you create. No module-level network access.
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { crowdBuyAbi, jitterBeaconAbi, savingsVaultAbi } from "./abi";

export { crowdBuyAbi, jitterBeaconAbi, savingsVaultAbi };

export type UnsignedTx = { to: Address; data: Hex };
export type MixEntry = { stockToken: Address; weightBps: number };
/** Delivery mode: 0 Open (tokens to your address), 1 Quiet (stealth addresses), 2 Hidden (shielded notes). */
export type DeliveryMode = 0 | 1 | 2;
export type Settings = { roundTo: 1 | 5 | 10; multiplier: 1 | 2 | 3; weeklyCap: bigint; fixedTopUp: bigint; mode: DeliveryMode };
export type Book = { usdgTotal: bigint; accounts: number; openedAt: bigint; rawOut: bigint; executed: boolean };

export const BPS = 10_000;
export const MAX_MIX = 5;
export const WINDOW = 86_400n;

const tx = (to: Address, abi: any, functionName: string, args: readonly unknown[]): UnsignedTx => ({
  to: getAddress(to),
  data: encodeFunctionData({ abi, functionName, args } as any),
});

// ------------------------------------------------------------------ saver (SavingsVault)

/** deposit(amount) into the vault's `available` balance (approve USDG to the vault first). */
export const vaultDepositTx = (vault: Address, amount: bigint) => tx(vault, savingsVaultAbi, "deposit", [amount]);
/** withdraw(amount, to): never gated (no pause, keeper or owner check). */
export const vaultWithdrawTx = (vault: Address, amount: bigint, to: Address) => tx(vault, savingsVaultAbi, "withdraw", [amount, to]);
export const setSettingsTx = (vault: Address, s: Settings) => tx(vault, savingsVaultAbi, "setSettings", [s]);

/** Checks a mix the way SavingsVault.setMix does (1-5 distinct tokens, weights > 0 summing to 10000). */
export function validateMix(mix: readonly MixEntry[]): void {
  if (mix.length === 0 || mix.length > MAX_MIX) throw new Error(`mix must have 1-${MAX_MIX} entries`);
  const seen = new Set<string>();
  let sum = 0;
  for (const m of mix) {
    if (!Number.isInteger(m.weightBps) || m.weightBps <= 0 || m.weightBps > 0xffff) throw new Error("mix weights must be positive integers");
    const k = m.stockToken.toLowerCase();
    if (seen.has(k)) throw new Error("mix tokens must be distinct");
    seen.add(k);
    sum += m.weightBps;
  }
  if (sum !== BPS) throw new Error("mix weights must sum to 10000");
}

export function setMixTx(vault: Address, mix: readonly MixEntry[]): UnsignedTx {
  validateMix(mix);
  return tx(vault, savingsVaultAbi, "setMix", [mix.map((m) => ({ stockToken: getAddress(m.stockToken), weightBps: m.weightBps }))]);
}

// ------------------------------------------------------------------ crowd (CrowdBuy)

/** join(user): anyone may send it; it only moves `user`'s own pending USDG into `user`'s orders. */
export const joinTx = (crowd: Address, user: Address) => tx(crowd, crowdBuyAbi, "join", [user]);
/** cancel(asset, bookId): sender's whole order in a not-yet-executed book goes back to their vault balance. */
export const cancelTx = (crowd: Address, asset: Address, bookId: bigint) => tx(crowd, crowdBuyAbi, "cancel", [asset, bookId]);
/** execute(asset): anyone, once the crowd is big enough and the window's beacon time has passed. */
export const executeTx = (crowd: Address, asset: Address) => tx(crowd, crowdBuyAbi, "execute", [asset]);
/** claimOpen(asset, bookId): the ungated exit, tokens to the sender's own address (public). */
export const claimOpenTx = (crowd: Address, asset: Address, bookId: bigint) => tx(crowd, crowdBuyAbi, "claimOpen", [asset, bookId]);

/** The split `join` makes: floor(amount * weight / 10000) per entry, the last entry takes the remainder. */
export function splitByMix(amount: bigint, mix: readonly MixEntry[]): bigint[] {
  let placed = 0n;
  return mix.map((m, i) => {
    const part = i === mix.length - 1 ? amount - placed : (amount * BigInt(m.weightBps)) / BigInt(BPS);
    placed += part;
    return part;
  });
}

/** floor(rawOut * order / usdgTotal): CrowdBuy.allocationOf, raw token units (never scaled by uiMultiplier). */
export function allocation(rawOut: bigint, order: bigint, usdgTotal: bigint): bigint {
  if (usdgTotal === 0n) return 0n;
  return (rawOut * order) / usdgTotal;
}

/** CrowdBuy.windowOf: the fixed 24h grid from GENESIS. */
export function windowOf(genesis: bigint, t: bigint): { start: bigint; end: bigint } {
  if (t < genesis) throw new Error("before genesis");
  const start = genesis + ((t - genesis) / WINDOW) * WINDOW;
  return { start, end: start + WINDOW };
}

/** CrowdBuy.beaconKey: keccak256(abi.encode(asset, windowStart)). */
export function beaconKey(asset: Address, windowStart: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [getAddress(asset), windowStart]));
}

// ------------------------------------------------------------------ reads

export async function openBook(pub: PublicClient, crowd: Address, asset: Address): Promise<{ bookId: bigint; book: Book }> {
  const [bookId, b] = (await pub.readContract({ address: crowd, abi: crowdBuyAbi, functionName: "openBook", args: [asset] })) as readonly [bigint, Book];
  return { bookId, book: { ...b } };
}

/** Earliest time the current window's execution may happen (uint64 max when the window has no beacon). */
export async function nextExecution(pub: PublicClient, crowd: Address, asset: Address, at?: bigint): Promise<{ windowStart: bigint; executeAfter: bigint }> {
  const now = at ?? (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const [genesis, beacon] = await Promise.all([
    pub.readContract({ address: crowd, abi: crowdBuyAbi, functionName: "GENESIS" }) as Promise<bigint>,
    pub.readContract({ address: crowd, abi: crowdBuyAbi, functionName: "beacon" }) as Promise<Address>,
  ]);
  const { start } = windowOf(genesis, now);
  const executeAfter = (await pub.readContract({ address: beacon, abi: jitterBeaconAbi, functionName: "executeAfter", args: [beaconKey(asset, start)] })) as bigint;
  return { windowStart: start, executeAfter };
}

/** Maps are keyed by checksummed address (viem `getAddress`). */
export type RecomputedBook = { bookId: bigint; usdgTotal: bigint; rawOut: bigint; accounts: number; orders: Map<Address, bigint>; allocations: Map<Address, bigint> };

/**
 * Recomputes a book's allocations from logs alone: each order is the sum of the user's Joined events minus a
 * Cancelled event; Executed gives total and rawOut. Matches allocationOf exactly (the "allocation proof").
 */
export async function recomputeBook(pub: PublicClient, crowd: Address, asset: Address, bookId: bigint, fromBlock = 0n): Promise<RecomputedBook> {
  const args = { asset, bookId };
  const ev = (name: string) => crowdBuyAbi.find((x) => x.type === "event" && x.name === name) as any;
  const [joined, cancelled, executed] = await Promise.all(
    ["Joined", "Cancelled", "Executed"].map((n) => pub.getLogs({ address: crowd, event: ev(n), args, fromBlock, toBlock: "latest" }) as Promise<any[]>),
  );
  // Replay in chain order: a user may cancel and then join the same book again.
  const pos = (l: any) => (BigInt(l.blockNumber) << 32n) + BigInt(l.logIndex);
  const events = [...joined.map((l) => ({ l, join: true })), ...cancelled.map((l) => ({ l, join: false }))].sort((a, b) => (pos(a.l) < pos(b.l) ? -1 : pos(a.l) > pos(b.l) ? 1 : 0));
  const orders = new Map<Address, bigint>();
  for (const { l, join } of events) {
    const user = getAddress(l.args.user);
    if (join) orders.set(user, (orders.get(user) ?? 0n) + l.args.usdg);
    else orders.delete(user);
  }
  const ex = executed[0];
  if (!ex) throw new Error("book not executed");
  const { usdgTotal, rawOut, accounts } = ex.args as { usdgTotal: bigint; rawOut: bigint; accounts: number };
  const sum = [...orders.values()].reduce((a, b) => a + b, 0n);
  if (sum !== usdgTotal || orders.size !== Number(accounts)) throw new Error("logs do not add up to the Executed event");
  const allocations = new Map<Address, bigint>();
  for (const [u, o] of orders) allocations.set(u, allocation(rawOut, o, usdgTotal));
  return { bookId, usdgTotal, rawOut, accounts: Number(accounts), orders, allocations };
}
export { CHAIN_IDS, parseDeployment, publicInfra, type Network, type PlynthDeployment, type PublicInfra } from "../defaults";
