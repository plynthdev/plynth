// One vault.accrue for one spend, shared by every source. Pre-simulated as the keeper: AlreadyAccrued (the
// vault's replay guard) means some earlier pass already did it, so it is done, not failed.
import { sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx } from "@/keeper/context";

export type AccrueOutcome =
  | { status: "done"; added?: bigint | undefined; tx?: Hex | undefined; gasUsed?: bigint | undefined; reason?: string | undefined }
  | { status: "failed"; reason: string };

/** `beforeSend` runs after a clean simulation, right before broadcasting (e.g. to record "pending"). */
export async function accrueSpend(ctx: Ctx, user: Address, sourceTx: Hex, logIndex: number, units: bigint, beforeSend?: () => Promise<void>): Promise<AccrueOutcome> {
  const args = [getAddress(user), sourceTx, logIndex, units] as const;
  const sim = await simulate(ctx, ctx.dep.vault, vaultAbi, "accrue", args);
  if (!sim.ok) {
    if (sim.errorName === "AlreadyAccrued") return { status: "done", reason: "already accrued" };
    return { status: "failed", reason: sim.errorName };
  }
  await beforeSend?.();
  const r = await ctx.sender.sendCall(ctx.dep.vault, vaultAbi, "accrue", args, "accrue");
  return { status: "done", added: addedFromReceipt(r, ctx.dep.vault), tx: r.transactionHash, gasUsed: r.gasUsed };
}

/** SavingsVault.MAX_ACCRUE_BATCH: the most spends one accrueBatch takes (checked against the contract on anvil). */
export const MAX_ACCRUE_BATCH = 32;

export type BatchItem = { sourceTx: Hex; logIndex: number; units: bigint };
export type BatchOutcome =
  | { status: "done"; tx: Hex; gasUsed: bigint; added: Map<string, bigint>; total: bigint }
  /** The vault already has this key (an earlier pass or a single accrue): the whole batch would revert. */
  | { status: "replay"; sourceTx: Hex; logIndex: number }
  | { status: "failed"; reason: string };

export const batchKey = (sourceTx: string, logIndex: number) => `${sourceTx.toLowerCase()}:${logIndex}`;

/**
 * One vault.accrueBatch for up to MAX_ACCRUE_BATCH spends of one user (carried sub-minimum on-chain round-ups, review
 * v3 R3-SVC-2). Pre-simulated as the keeper like accrueSpend; an AlreadyAccrued revert names the key so the caller can
 * mark it done and send the rest. `added` maps batchKey(sourceTx, logIndex) to what the vault moved for that spend.
 */
export async function accrueBatchSpends(ctx: Ctx, user: Address, items: readonly BatchItem[]): Promise<BatchOutcome> {
  if (items.length === 0 || items.length > MAX_ACCRUE_BATCH) return { status: "failed", reason: `batch of ${items.length} spends` };
  const args = [getAddress(user), items.map((i) => i.sourceTx), items.map((i) => i.logIndex), items.map((i) => i.units)] as const;
  const sim = await simulate(ctx, ctx.dep.vault, vaultAbi, "accrueBatch", args);
  if (!sim.ok) {
    if (sim.errorName === "AlreadyAccrued" && sim.args && sim.args.length >= 2) return { status: "replay", sourceTx: sim.args[0] as Hex, logIndex: Number(sim.args[1]) };
    return { status: "failed", reason: sim.errorName };
  }
  let r: TransactionReceipt;
  try {
    r = await ctx.sender.sendCall(ctx.dep.vault, vaultAbi, "accrueBatch", args, "accrueBatch");
  } catch (err) {
    return { status: "failed", reason: (err as Error).message.split("\n")[0]! };
  }
  const added = accruedFromReceipt(r, ctx.dep.vault);
  let total = 0n;
  for (const v of added.values()) total += v;
  return { status: "done", tx: r.transactionHash, gasUsed: r.gasUsed, added, total };
}

/** Every Accrued event of the vault in a receipt: batchKey(sourceTx, logIndex) -> added. */
export function accruedFromReceipt(r: TransactionReceipt, vault: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Accrued") {
        const a = ev.args as { sourceTx: Hex; logIndex: number; added: bigint };
        out.set(batchKey(a.sourceTx, Number(a.logIndex)), a.added);
      }
    } catch {
      // another vault event
    }
  }
  return out;
}

/** The `added` amount from the vault's Accrued event in a receipt. */
export function addedFromReceipt(r: TransactionReceipt, vault: string): bigint | undefined {
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Accrued") return (ev.args as { added: bigint }).added;
    } catch {
      // another vault event
    }
  }
  return undefined;
}


// ---------------------------------------------------------------- budget (audit M-7)
//
// vault.accrue never reverts for a user it cannot credit: with no settings, no available balance or no room under
// the weekly cap it adds 0 and only burns the replay key. Anyone can sign a statement import, so without a gate one
// unfunded wallet made the keeper pay for thousands of such transactions. The gate mirrors the vault's arithmetic
// before sending anything:
//   - a spend the vault would credit 0 for (no settings, nothing available, cap reached, an exact amount) is skipped
//     with that reason, exactly what accrue would have done, minus the gas;
//   - at most `perUserWeek` keeper accrue transactions per user in any 7 days, and `perPass` per job per keeper pass;
//   - while one is sent, the gate tracks available and the week's room as the vault will see them.
//
// Review v2 (V2-M5): sybils with 1 USDG each still bought keeper transactions: roundTo 1 and rows of $x.99 make every
// row a real 1-cent accrual, so 20 sybils (20 USDG, not lost) filled every pass with 200 sequential sends. So also:
//   - a minimum round-up per accrue (`minAccrueCents`, default $0.25, for imported statement / Plaid rows; on-chain
//     spends cost their sender a transaction each and keep 0): each keeper transaction then moves at least $0.25 of
//     the user's own money into savings, except at most one clip at the weekly cap and one at the balance;
//   - at most `perUserPass` accruals per user per pass, so one user's rows cannot take the whole pass;
//   - a wall-clock budget (`passMs`) and a gas budget (`passGas`) per pass: once spent, the rest waits for the next
//     pass, so the core jobs of the next pass (liquidate, fee-push, execute, delivery...) always start on time.

export const DEFAULT_MAX_ACCRUALS_PER_PASS = 200;
export const DEFAULT_MAX_ACCRUALS_PER_USER_WEEK = 100;
export const DEFAULT_MAX_ACCRUALS_PER_USER_PASS = 10;
export const DEFAULT_MIN_ACCRUE_CENTS = 25;
/**
 * Review v3 (R3-SVC-2): the least round-up an ON-CHAIN spend must have for the keeper to accrue it. It used to be 0, so
 * a linked sybil sending 0.999999 USDG transfers (about $0.004 of its own gas each) bought one 57.5k-gas keeper accrue
 * per transfer, each moving 1e-6 USDG, ahead of sweep / beacon / execute. 5 cents: each keeper transaction moves about
 * ten times its own gas cost (0.02 gwei, ETH $4000) of the user's money into savings. Smaller round-ups are carried
 * forward and sent together in one accrueBatch once a user's carried round-ups reach it (jobs/roundups.ts).
 */
export const DEFAULT_MIN_ONCHAIN_ACCRUE_CENTS = 5;
export const DEFAULT_ACCRUE_PASS_MS = 10_000;
export const DEFAULT_ACCRUE_PASS_GAS = 5_000_000n;
const WEEK_S = 604_800n;

export type AccrueLimits = { perPass: number; perUserWeek: number; perUserPass: number; minAccrueCents: number; passMs: number; passGas: bigint };
/** `belowMin`: the only objection is the minimum round-up (an on-chain spend the roundups job carries forward). */
export type GateDecision = { ok: true } | { ok: false; skip: true; reason: string; belowMin?: true } | { ok: false; skip: false; reason: string };

type Budget = { roundTo: number; multiplier: number; available: bigint; room: bigint; sentThisWeek: number; sentThisPass: number };

/** SavingsVault.roundUp: (roundTo * unit - spend % (roundTo * unit)) * multiplier, 0 for an exact amount. */
export function roundUpOf(spend: bigint, roundTo: number, multiplier: number, unit: bigint): bigint {
  if (roundTo === 0) return 0n;
  const u = BigInt(roundTo) * unit;
  const rem = spend % u;
  return rem === 0n ? 0n : (u - rem) * BigInt(multiplier);
}

export class AccrueGate {
  private sent = 0;
  private gas = 0n;
  private readonly started: number;
  private readonly now: () => number;
  private unit?: bigint;
  private week?: bigint;
  private readonly users = new Map<string, Budget>();
  readonly limits: AccrueLimits;

  constructor(
    private readonly ctx: Ctx,
    limits: Partial<AccrueLimits> & { now?: () => number } = {},
  ) {
    const c = ctx.accrueLimits;
    this.limits = {
      perPass: limits.perPass ?? c?.perPass ?? DEFAULT_MAX_ACCRUALS_PER_PASS,
      perUserWeek: limits.perUserWeek ?? c?.perUserWeek ?? DEFAULT_MAX_ACCRUALS_PER_USER_WEEK,
      perUserPass: limits.perUserPass ?? c?.perUserPass ?? DEFAULT_MAX_ACCRUALS_PER_USER_PASS,
      minAccrueCents: limits.minAccrueCents ?? c?.minAccrueCents ?? DEFAULT_MIN_ACCRUE_CENTS,
      passMs: limits.passMs ?? c?.passMs ?? DEFAULT_ACCRUE_PASS_MS,
      passGas: limits.passGas ?? c?.passGas ?? DEFAULT_ACCRUE_PASS_GAS,
    };
    this.now = limits.now ?? Date.now;
    this.started = this.now();
  }

  /** Accrue transactions sent through this gate so far in the pass. */
  get sentThisPass(): number {
    return this.sent;
  }

  /** Gas used by this pass's accrue transactions (from their receipts). */
  get gasThisPass(): bigint {
    return this.gas;
  }

  /** Why the pass budget is spent, or undefined while there is room. */
  passSpent(): string | undefined {
    if (this.sent >= this.limits.perPass) return `keeper pass budget of ${this.limits.perPass} accruals used; next pass`;
    if (this.gas >= this.limits.passGas) return `keeper pass gas budget of ${this.limits.passGas} used; next pass`;
    if (this.now() - this.started >= this.limits.passMs) return `keeper pass time budget of ${this.limits.passMs} ms used; next pass`;
    return undefined;
  }

  passFull(): boolean {
    return this.passSpent() !== undefined;
  }

  private async chainWeek(): Promise<bigint> {
    if (this.week === undefined) {
      const now = await this.ctx.pub
        .getBlock({ blockTag: "latest" })
        .then((b) => b.timestamp)
        .catch(() => BigInt(Math.floor(Date.now() / 1000)));
      this.week = now / WEEK_S;
    }
    return this.week;
  }

  private async budget(user: Address): Promise<Budget> {
    const k = user.toLowerCase();
    const have = this.users.get(k);
    if (have) return have;
    const [s, a] = (await Promise.all([
      this.ctx.pub.readContract({ address: this.ctx.dep.vault, abi: vaultAbi, functionName: "settingsOf", args: [user] }),
      this.ctx.pub.readContract({ address: this.ctx.dep.vault, abi: vaultAbi, functionName: "accountOf", args: [user] }),
    ])) as [{ roundTo: number; multiplier: number; weeklyCap: bigint }, { available: bigint; week: bigint; accruedThisWeek: bigint }];
    this.unit ??= (await this.ctx.pub.readContract({ address: this.ctx.dep.vault, abi: vaultAbi, functionName: "unit" })) as bigint;
    const week = await this.chainWeek();
    const accrued = BigInt(a.week) === week ? BigInt(a.accruedThisWeek) : 0n;
    const cap = BigInt(s.weeklyCap);
    const [r] = (await this.ctx.db.execute(sql`
      select (select count(*) from roundup_events where chain_id = ${this.ctx.chainId} and user_address = ${k} and accrue_tx is not null and updated_at >= now() - interval '7 days')
           + (select count(distinct accrue_tx) from keeper_roundups where chain_id = ${this.ctx.chainId} and user_address = ${k} and accrue_tx is not null and updated_at >= now() - interval '7 days') as n`)) as unknown as { n: string | number }[];
    const b: Budget = { roundTo: Number(s.roundTo), multiplier: Number(s.multiplier), available: BigInt(a.available), room: cap > accrued ? cap - accrued : 0n, sentThisWeek: Number(r?.n ?? 0), sentThisPass: 0 };
    this.users.set(k, b);
    return b;
  }

  /** May the keeper send vault.accrue(user, ..., units) now? */
  async check(user: Address, units: bigint): Promise<GateDecision> {
    return this.decide(user, [units]);
  }

  /**
   * May the keeper send one vault.accrueBatch(user, ...) for these spends now? Same rules as `check`, the batch counting
   * as ONE keeper transaction and the minimum applying to the sum of its round-ups (each computed with the settings in
   * force now, as the vault will).
   */
  async checkBatch(user: Address, units: readonly bigint[]): Promise<GateDecision> {
    return this.decide(user, units);
  }

  /** The user's rounding as the vault applies it now: roundTo whole USDG, multiplier, and USDG's unit. */
  async roundingOf(user: Address): Promise<{ roundTo: number; multiplier: number; unit: bigint }> {
    const b = await this.budget(user);
    return { roundTo: b.roundTo, multiplier: b.multiplier, unit: this.unit! };
  }

  private async decide(user: Address, units: readonly bigint[]): Promise<GateDecision> {
    const spent = this.passSpent();
    if (spent) return { ok: false, skip: false, reason: spent };
    const b = await this.budget(user);
    if (b.roundTo === 0) return { ok: false, skip: true, reason: "no savings settings: the vault would add 0" };
    if (b.available === 0n) return { ok: false, skip: true, reason: "no available balance: the vault would add 0" };
    if (b.room === 0n) return { ok: false, skip: true, reason: "weekly cap reached: the vault would add 0" };
    const r = units.reduce((m, u) => m + roundUpOf(u, b.roundTo, b.multiplier, this.unit!), 0n);
    if (r === 0n) return { ok: false, skip: true, reason: "no round-up (whole amount): the vault would add 0" };
    // On the round-up itself, not on the amount clipped by room or balance: a clip uses that resource up, so it can
    // happen at most twice per user per week, and an honest saver's last accrual under the cap still goes through.
    const min = (BigInt(this.limits.minAccrueCents) * this.unit!) / 100n;
    if (r < min) return { ok: false, skip: true, belowMin: true, reason: `round-up below the keeper minimum of ${this.limits.minAccrueCents} cents per accrual` };
    if (b.sentThisWeek >= this.limits.perUserWeek) return { ok: false, skip: true, reason: `weekly limit of ${this.limits.perUserWeek} accruals for this user reached` };
    // Not a skip: this user's remaining rows wait for the next pass, other users go on.
    if (b.sentThisPass >= this.limits.perUserPass) return { ok: false, skip: false, reason: `pass limit of ${this.limits.perUserPass} accruals for this user reached; next pass` };
    return { ok: true };
  }

  /** After a sent accrue: what the vault moved (from the receipt), or the round-up clipped like the vault does. */
  record(user: Address, units: bigint, added: bigint | undefined, gasUsed?: bigint) {
    this.sent++;
    this.gas += gasUsed ?? 0n;
    const b = this.users.get(user.toLowerCase());
    if (!b) return;
    const r = roundUpOf(units, b.roundTo, b.multiplier, this.unit ?? 0n);
    const moved = added ?? [r, b.room, b.available].reduce((m, x) => (x < m ? x : m));
    b.available = b.available > moved ? b.available - moved : 0n;
    b.room = b.room > moved ? b.room - moved : 0n;
    b.sentThisWeek++;
    b.sentThisPass++;
  }

  /** After a sent accrueBatch: one keeper transaction that moved `added` in total (sum of its Accrued events). */
  recordBatch(user: Address, added: bigint, gasUsed?: bigint) {
    this.sent++;
    this.gas += gasUsed ?? 0n;
    const b = this.users.get(user.toLowerCase());
    if (!b) return;
    b.available = b.available > added ? b.available - added : 0n;
    b.room = b.room > added ? b.room - added : 0n;
    b.sentThisWeek++;
    b.sentThisPass++;
  }
}
