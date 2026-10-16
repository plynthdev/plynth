// One vault.accrue for one spend, shared by every source. Pre-simulated as the keeper: AlreadyAccrued (the
// vault's replay guard) means some earlier pass already did it, so it is done, not failed.
import { sql } from "drizzle-orm";
import { decodeEventLog, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx } from "@/keeper/context";

export type AccrueOutcome =
  | { status: "done"; added?: bigint | undefined; tx?: Hex | undefined; reason?: string | undefined }
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
  return { status: "done", added: addedFromReceipt(r, ctx.dep.vault), tx: r.transactionHash };
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

export const DEFAULT_MAX_ACCRUALS_PER_PASS = 200;
export const DEFAULT_MAX_ACCRUALS_PER_USER_WEEK = 100;
const WEEK_S = 604_800n;

export type AccrueLimits = { perPass: number; perUserWeek: number };
export type GateDecision = { ok: true } | { ok: false; skip: true; reason: string } | { ok: false; skip: false; reason: string };

type Budget = { roundTo: number; multiplier: number; available: bigint; room: bigint; sentThisWeek: number };

/** SavingsVault.roundUp: (roundTo * unit - spend % (roundTo * unit)) * multiplier, 0 for an exact amount. */
export function roundUpOf(spend: bigint, roundTo: number, multiplier: number, unit: bigint): bigint {
  if (roundTo === 0) return 0n;
  const u = BigInt(roundTo) * unit;
  const rem = spend % u;
  return rem === 0n ? 0n : (u - rem) * BigInt(multiplier);
}

export class AccrueGate {
  private sent = 0;
  private unit?: bigint;
  private week?: bigint;
  private readonly users = new Map<string, Budget>();
  readonly limits: AccrueLimits;

  constructor(
    private readonly ctx: Ctx,
    limits: Partial<AccrueLimits> = {},
  ) {
    this.limits = { perPass: limits.perPass ?? ctx.accrueLimits?.perPass ?? DEFAULT_MAX_ACCRUALS_PER_PASS, perUserWeek: limits.perUserWeek ?? ctx.accrueLimits?.perUserWeek ?? DEFAULT_MAX_ACCRUALS_PER_USER_WEEK };
  }

  /** Accrue transactions sent through this gate so far in the pass. */
  get sentThisPass(): number {
    return this.sent;
  }

  passFull(): boolean {
    return this.sent >= this.limits.perPass;
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
           + (select count(*) from keeper_roundups where chain_id = ${this.ctx.chainId} and user_address = ${k} and accrue_tx is not null and updated_at >= now() - interval '7 days') as n`)) as unknown as { n: string | number }[];
    const b: Budget = { roundTo: Number(s.roundTo), multiplier: Number(s.multiplier), available: BigInt(a.available), room: cap > accrued ? cap - accrued : 0n, sentThisWeek: Number(r?.n ?? 0) };
    this.users.set(k, b);
    return b;
  }

  /** May the keeper send vault.accrue(user, ..., units) now? */
  async check(user: Address, units: bigint): Promise<GateDecision> {
    if (this.passFull()) return { ok: false, skip: false, reason: `keeper pass budget of ${this.limits.perPass} accruals used; next pass` };
    const b = await this.budget(user);
    if (b.roundTo === 0) return { ok: false, skip: true, reason: "no savings settings: the vault would add 0" };
    if (b.available === 0n) return { ok: false, skip: true, reason: "no available balance: the vault would add 0" };
    if (b.room === 0n) return { ok: false, skip: true, reason: "weekly cap reached: the vault would add 0" };
    if (roundUpOf(units, b.roundTo, b.multiplier, this.unit!) === 0n) return { ok: false, skip: true, reason: "no round-up (whole amount): the vault would add 0" };
    if (b.sentThisWeek >= this.limits.perUserWeek) return { ok: false, skip: true, reason: `weekly limit of ${this.limits.perUserWeek} accruals for this user reached` };
    return { ok: true };
  }

  /** After a sent accrue: what the vault moved (from the receipt), or the round-up clipped like the vault does. */
  record(user: Address, units: bigint, added: bigint | undefined) {
    this.sent++;
    const b = this.users.get(user.toLowerCase());
    if (!b) return;
    const r = roundUpOf(units, b.roundTo, b.multiplier, this.unit ?? 0n);
    const moved = added ?? [r, b.room, b.available].reduce((m, x) => (x < m ? x : m));
    b.available = b.available > moved ? b.available - moved : 0n;
    b.room = b.room > moved ? b.room - moved : 0n;
    b.sentThisWeek++;
  }
}
