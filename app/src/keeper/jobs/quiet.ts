// Job 6: deliver-quiet. For every executed book, every joined user whose vault mode is Quiet (1) and who has an
// ERC-6538 scheme-1 meta-address:
//   1. plan: split the allocation into SPLIT_PARTS (1-3, default 2) random parts, a fresh stealth address each
//      (stored as one row before anything is sent, so a retry reuses the same plan);
//   2. crowd.deliver(asset, bookId, user, Quiet): settles the allocation into StealthClaims' unassigned pool;
//   3. release part i once i more executions (of any asset) have happened since the plan:
//      crowd.deliverStealth(asset, stealth, raw, ephemeralPubKey, viewTag), shuffled across users.
// Step 2 names the user, step 3 names only stealth addresses; they are always separate transactions.
//
// Double-credit guard: deliverStealth draws from a pool shared by all Quiet users, so a part is marked
// "sending" (with the block it was sent from) before its transaction, and a retry first checks the chain for
// a Credited log for that never-reused stealth address.
//
// Privacy note: the plan row links user to stealth addresses; it is scrubbed to amounts once every part is out.
import { computeStealthAddress } from "@plynth/sdk/stealth";
import { sql } from "drizzle-orm";
import { encodeAbiParameters, getAddress, parseAbiItem, type Address, type Hex } from "viem";
import { crowdAbi, stealthClaimsAbi, vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import { getJob, insertJobIfAbsent, setJob } from "@/keeper/jobstore";

export const QUIET_ROUTE: Hex = encodeAbiParameters([{ type: "uint8" }], [1]);
export const DEFAULT_SPLIT_PARTS = 2;
const registryAbi = [parseAbiItem("function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)")] as const;
const creditedEvent = parseAbiItem("event Credited(address indexed token, address indexed stealth, uint256 raw)");

export type PlannedPart = { stealth: Address; ephemeralPublicKey: Hex; viewTag: Hex; raw: string; releaseAt: number };
export type Plan = { asset: Address; bookId: string; user: Address; allocation: string; parts: PlannedPart[] };

export function splitParts(env: string | undefined): number {
  if (env === undefined || env === "") return DEFAULT_SPLIT_PARTS;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error(`SPLIT_PARTS must be 1, 2 or 3 (got ${env})`);
  return n;
}

/**
 * Splits `total` into at most `n` positive parts with random weights; sum is exact. Fewer parts when
 * total < n; none when total is 0. `rand` returns integers in [1, 1000] (injectable for tests).
 */
export function splitAmount(total: bigint, n: number, rand: () => number = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 1000)): bigint[] {
  if (total <= 0n) return [];
  const k = Number(total < BigInt(n) ? total : BigInt(n));
  const w = Array.from({ length: k }, () => BigInt(rand()));
  const sumW = w.reduce((a, b) => a + b, 0n);
  const spare = total - BigInt(k); // every part gets 1, the rest is shared by weight
  const parts = w.map((wi) => 1n + (spare * wi) / sumW);
  const placed = parts.reduce((a, b) => a + b, 0n);
  parts[k - 1] = parts[k - 1]! + (total - placed);
  return parts;
}

/** Fisher-Yates with crypto randomness. */
export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Parts whose turn has come: part.releaseAt <= executions so far, and not already out. */
export function releasable(plan: Plan, executions: number, done: Set<number>): number[] {
  return plan.parts.map((p, i) => (p.releaseAt <= executions && !done.has(i) ? i : -1)).filter((i) => i >= 0);
}

const planKey = (asset: string, bookId: string, user: string) => `${asset.toLowerCase()}:${bookId}:${user.toLowerCase()}`;

async function executions(ctx: Ctx): Promise<number> {
  const [r] = (await ctx.db.execute(sql`
    select count(*)::int as n from ev_logs
    where chain_id = ${ctx.chainId} and address = ${ctx.dep.crowd.toLowerCase()} and data_json->>'eventName' = 'Executed'`)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

/** (asset, bookId, user) joined into an executed book, not yet delivered or skipped by this job. */
async function candidates(ctx: Ctx): Promise<{ asset: Address; bookId: string; user: Address }[]> {
  const rows = (await ctx.db.execute(sql`
    select distinct j.data_json->'args'->>'asset' as asset, j.data_json->'args'->>'bookId' as book_id, j.data_json->'args'->>'user' as u
    from ev_logs j
    where j.chain_id = ${ctx.chainId} and j.address = ${ctx.dep.crowd.toLowerCase()} and j.data_json->>'eventName' = 'Joined'
      and exists (
        select 1 from ev_logs e
        where e.chain_id = j.chain_id and e.address = j.address and e.data_json->>'eventName' = 'Executed'
          and e.data_json->'args'->>'asset' = j.data_json->'args'->>'asset' and e.data_json->'args'->>'bookId' = j.data_json->'args'->>'bookId')
      and not exists (
        select 1 from keeper_jobs k
        where k.chain_id = j.chain_id and k.kind = 'quiet-plan' and k.status in ('delivered', 'done', 'skipped')
          and k.job_key = lower(j.data_json->'args'->>'asset') || ':' || (j.data_json->'args'->>'bookId') || ':' || lower(j.data_json->'args'->>'user'))
    order by 1, 2, 3`)) as unknown as { asset: string; book_id: string; u: string }[];
  return rows.map((r) => ({ asset: getAddress(r.asset), bookId: r.book_id, user: getAddress(r.u) }));
}

async function deliverPhase(ctx: Ctx, res: JobResult, execCount: number): Promise<void> {
  const n = ctx.splitParts ?? DEFAULT_SPLIT_PARTS;
  for (const { asset, bookId, user } of await candidates(ctx)) {
    const key = planKey(asset, bookId, user);
    const settled = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "settled", args: [asset, BigInt(bookId), user] })) as boolean;
    const existing = await getJob(ctx, "quiet-plan", key);
    if (settled) {
      // Either our deliver landed and the receipt was lost (plan exists), or the user claimed openly.
      if (existing) await setJob(ctx, "quiet-plan", key, { status: "delivered" });
      else await setJob(ctx, "quiet-plan", key, { status: "skipped", payload: { reason: "settled without Quiet delivery (claimed openly or cancelled)" } });
      continue;
    }
    const order = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "orderOf", args: [asset, BigInt(bookId), user] })) as bigint;
    if (order === 0n) {
      await setJob(ctx, "quiet-plan", key, { status: "skipped", payload: { reason: "no order (cancelled)" } });
      continue;
    }
    const mode = ((await ctx.pub.readContract({ address: ctx.dep.vault, abi: vaultAbi, functionName: "settingsOf", args: [user] })) as { mode: number }).mode;
    if (Number(mode) !== 1) continue; // Open users claim themselves; re-checked every pass in case they switch
    const meta = (await ctx.pub.readContract({ address: ctx.dep.erc6538Registry, abi: registryAbi, functionName: "stealthMetaAddressOf", args: [user, 1n] })) as Hex;
    if (meta === "0x" || meta.length !== 2 + 132) {
      res.notes.push(`${user}: Quiet but no valid ERC-6538 meta-address`);
      continue;
    }
    if (!existing) {
      const allocation = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "allocationOf", args: [asset, BigInt(bookId), user] })) as bigint;
      const parts = splitAmount(allocation, n).map((raw, i): PlannedPart => {
        const g = computeStealthAddress(meta);
        return { stealth: g.stealthAddress, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag, raw: raw.toString(), releaseAt: execCount + i };
      });
      const plan: Plan = { asset, bookId, user, allocation: allocation.toString(), parts };
      await insertJobIfAbsent(ctx, "quiet-plan", key, { status: "planned", payload: plan });
    }
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "deliver", [asset, BigInt(bookId), user, QUIET_ROUTE]);
    if (!sim.ok) {
      res.notes.push(`${user} ${asset} book ${bookId}: deliver reverts ${sim.errorName}`);
      continue;
    }
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliver", [asset, BigInt(bookId), user, QUIET_ROUTE], "deliver-quiet");
    await setJob(ctx, "quiet-plan", key, { status: "delivered", txHash: r.transactionHash });
    res.actions++;
  }
}

async function alreadyCredited(ctx: Ctx, asset: Address, stealth: Address, fromBlock: bigint): Promise<boolean> {
  const bal = (await ctx.pub.readContract({ address: ctx.dep.stealthClaims!, abi: stealthClaimsAbi, functionName: "balanceOf", args: [asset, stealth] })) as bigint;
  if (bal > 0n) return true;
  const logs = await ctx.pub.getLogs({ address: ctx.dep.stealthClaims!, event: creditedEvent, args: { token: asset, stealth }, fromBlock, toBlock: "latest" });
  return logs.length > 0;
}

async function releasePhase(ctx: Ctx, res: JobResult, execCount: number): Promise<void> {
  const plans = (await ctx.db.execute(sql`
    select job_key, payload from keeper_jobs where chain_id = ${ctx.chainId} and kind = 'quiet-plan' and status = 'delivered'`)) as unknown as { job_key: string; payload: Plan }[];
  type Item = { key: string; plan: Plan; i: number };
  const due: Item[] = [];
  const doneByPlan = new Map<string, Set<number>>();
  for (const { job_key, payload: plan } of plans) {
    const done = new Set<number>();
    const rows = (await ctx.db.execute(sql`
      select job_key, status, payload from keeper_jobs
      where chain_id = ${ctx.chainId} and kind = 'quiet-part' and job_key like ${`${job_key}:%`}`)) as unknown as { job_key: string; status: string; payload: { fromBlock?: string } | null }[];
    for (const row of rows) {
      const i = Number(row.job_key.slice(job_key.length + 1));
      if (row.status === "done") done.add(i);
      else if (row.status === "sending") {
        const part = plan.parts[i]!;
        if (await alreadyCredited(ctx, plan.asset, part.stealth, BigInt(row.payload?.fromBlock ?? "0"))) {
          await setJob(ctx, "quiet-part", row.job_key, { status: "done" });
          done.add(i);
        }
      }
    }
    doneByPlan.set(job_key, done);
    for (const i of releasable(plan, execCount, done)) due.push({ key: job_key, plan, i });
  }
  for (const { key, plan, i } of shuffle(due)) {
    const p = plan.parts[i]!;
    const args = [plan.asset, p.stealth, BigInt(p.raw), p.ephemeralPublicKey, p.viewTag] as const;
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "deliverStealth", args);
    if (!sim.ok) {
      res.notes.push(`part ${i} of ${plan.asset}: deliverStealth reverts ${sim.errorName}`);
      continue;
    }
    const fromBlock = await ctx.pub.getBlockNumber();
    await setJob(ctx, "quiet-part", `${key}:${i}`, { status: "sending", payload: { fromBlock } });
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliverStealth", args, "deliver-stealth");
    await setJob(ctx, "quiet-part", `${key}:${i}`, { status: "done", txHash: r.transactionHash });
    doneByPlan.get(key)!.add(i);
    res.actions++;
  }
  for (const { job_key, payload: plan } of plans) {
    if (doneByPlan.get(job_key)!.size === plan.parts.length) {
      // scrub the user -> stealth link; keep amounts for accounting
      await setJob(ctx, "quiet-plan", job_key, { status: "done", payload: { parts: plan.parts.map((p) => ({ raw: p.raw, releaseAt: p.releaseAt })) } });
    }
  }
}

export async function runDeliverQuiet(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "deliver-quiet", ok: true, actions: 0, notes: [] };
  if (!ctx.dep.stealthClaims) {
    res.notes.push("Quiet delivery not configured (no stealthClaims in deployment)");
    return res;
  }
  const execCount = await executions(ctx);
  await deliverPhase(ctx, res, execCount);
  await releasePhase(ctx, res, execCount);
  return res;
}
