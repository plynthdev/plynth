// Job 6: deliver-quiet. For every executed book, every joined user whose vault mode is Quiet (1) and who has an
// ERC-6538 scheme-1 meta-address:
//   1. plan: split the allocation into SPLIT_PARTS (1-3, default 2) random parts, a fresh stealth address each
//      (stored as one row before anything is sent, so a retry reuses the same plan);
//   2. crowd.deliver(asset, bookId, user, Quiet): settles the allocation into StealthClaims' unassigned pool;
//   3. release part i once i more executions (of any asset) have happened since the plan:
//      crowd.deliverStealth(asset, stealth, raw, ephemeralPubKey, viewTag), shuffled across users.
// Step 2 names the user, step 3 names only stealth addresses; they are always separate transactions.
//
// Double-credit guard: deliverStealth draws from a pool shared by all Quiet users and nothing on-chain stops a
// second credit, so a part's transaction must never be sent twice. A part is marked "sending" (stage "signing",
// with the block it was sent from) before signing; the signed transaction's hash, nonce and bytes are stored
// (stage "signed") BEFORE it is broadcast. A later pass (after a crash, a TxUnconfirmed or a reverted send)
// decides from that exact transaction, never from on-chain effects alone (a lagging node shows none):
//   - credited (balance or Credited log), or its receipt succeeded: done;
//   - its receipt reverted, or it was never signed: send again;
//   - no receipt and the keeper's confirmed nonce is not past it: it may still mine: rebroadcast the same bytes
//     (same nonce, so at most one can ever mine) and wait;
//   - no receipt and the nonce was taken by another transaction: ours can never mine. Only after a grace period
//     (and a later pass) and a re-check pinned to the block that showed the nonce taken is it sent again.
// A "sending" row without a recorded transaction from an older keeper is held for a manual check.
//
// Privacy note: the plan row links user to stealth addresses; it is scrubbed to amounts once every part is out.
import { computeStealthAddress } from "@plynth/sdk/stealth";
import { sql } from "drizzle-orm";
import { encodeAbiParameters, getAddress, parseAbiItem, type Address, type Hex } from "viem";
import { crowdAbi, stealthClaimsAbi, vaultAbi } from "@/abi/keeper";
import { simulate, type Ctx, type JobResult } from "@/keeper/context";
import type { SignedTx } from "@/keeper/sender";
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

async function alreadyCredited(ctx: Ctx, asset: Address, stealth: Address, fromBlock: bigint, atBlock?: bigint): Promise<boolean> {
  const bal = (await ctx.pub.readContract({ address: ctx.dep.stealthClaims!, abi: stealthClaimsAbi, functionName: "balanceOf", args: [asset, stealth], ...(atBlock === undefined ? {} : { blockNumber: atBlock }) })) as bigint;
  if (bal > 0n) return true;
  const logs = await ctx.pub.getLogs({ address: ctx.dep.stealthClaims!, event: creditedEvent, args: { token: asset, stealth }, fromBlock, toBlock: atBlock ?? "latest" });
  return logs.length > 0;
}

/** The quiet-part row while its transaction is out. */
export type SendingPayload = {
  fromBlock?: string;
  /** "signing": nothing was broadcast yet; "signed": hash/nonce/raw were stored before the first broadcast. */
  stage?: "signing" | "signed";
  hash?: Hex;
  nonce?: number;
  raw?: Hex | null;
  /** Wall-clock ms when the nonce was first seen taken while our transaction had no receipt. */
  takenSeenAt?: number | null;
};

export type ReleaseOptions = {
  now?: () => number;
  /** How long a taken nonce with no receipt is watched before the part is sent again (lagging nodes catch up). */
  takenGraceMs?: number;
};
export const TAKEN_GRACE_MS = 120_000;

type SendingDecision = { kind: "done"; txHash?: string } | { kind: "wait"; note: string; payload?: Partial<SendingPayload> } | { kind: "resend" };

/** What to do with a part whose earlier transaction may be out (see the header). */
export async function decideSending(ctx: Ctx, asset: Address, stealth: Address, p: SendingPayload, opts: ReleaseOptions = {}): Promise<SendingDecision> {
  const fromBlock = BigInt(p.fromBlock ?? "0");
  if (await alreadyCredited(ctx, asset, stealth, fromBlock)) return { kind: "done", ...(p.hash ? { txHash: p.hash } : {}) };
  if (p.stage === "signing") return { kind: "resend" }; // marked, but nothing was signed or broadcast
  if (p.stage !== "signed" || !p.hash || p.nonce === undefined) {
    return { kind: "wait", note: `stealth ${stealth}: "sending" without a recorded transaction (older keeper); check StealthClaims by hand, then mark it done or delete the row` };
  }
  const receipt = await ctx.sender.receiptOf(p.hash);
  if (receipt) return receipt.status === "success" ? { kind: "done", txHash: p.hash } : { kind: "resend" };
  const head = await ctx.pub.getBlockNumber();
  const confirmed = await ctx.pub.getTransactionCount({ address: ctx.sender.address, blockNumber: head });
  if (confirmed <= p.nonce) {
    if (p.raw) await ctx.sender.rebroadcast(p.raw);
    return { kind: "wait", note: `stealth ${stealth}: tx ${p.hash} (nonce ${p.nonce}) still pending`, ...(p.takenSeenAt ? { payload: { takenSeenAt: null } } : {}) };
  }
  // Our nonce is used and our hash has no receipt: another transaction took it, or a lagging node is hiding ours.
  const now = (opts.now ?? Date.now)();
  if (!p.takenSeenAt) return { kind: "wait", note: `stealth ${stealth}: nonce ${p.nonce} used, no receipt for ${p.hash} yet; re-checking later`, payload: { takenSeenAt: now } };
  if (now - p.takenSeenAt < (opts.takenGraceMs ?? TAKEN_GRACE_MS)) return { kind: "wait", note: `stealth ${stealth}: nonce ${p.nonce} used, waiting out the grace period` };
  // Pinned to `head`: a node that does not have that block errors instead of answering from the past.
  if (await alreadyCredited(ctx, asset, stealth, fromBlock, head)) return { kind: "done", txHash: p.hash };
  return { kind: "resend" };
}

export async function releasePhase(ctx: Ctx, res: JobResult, execCount: number, opts: ReleaseOptions = {}): Promise<void> {
  const plans = (await ctx.db.execute(sql`
    select job_key, payload from keeper_jobs where chain_id = ${ctx.chainId} and kind = 'quiet-plan' and status = 'delivered'`)) as unknown as { job_key: string; payload: Plan }[];
  type Item = { key: string; plan: Plan; i: number; fromBlock?: string | undefined };
  const due: Item[] = [];
  const doneByPlan = new Map<string, Set<number>>();
  for (const { job_key, payload: plan } of plans) {
    const done = new Set<number>();
    const held = new Set<number>();
    const resendFrom = new Map<number, string | undefined>();
    const rows = (await ctx.db.execute(sql`
      select job_key, status, payload from keeper_jobs
      where chain_id = ${ctx.chainId} and kind = 'quiet-part' and job_key like ${`${job_key}:%`}`)) as unknown as { job_key: string; status: string; payload: SendingPayload | null }[];
    for (const row of rows) {
      const i = Number(row.job_key.slice(job_key.length + 1));
      if (row.status === "done") done.add(i);
      else if (row.status === "sending") {
        const part = plan.parts[i]!;
        const p = row.payload ?? {};
        const d = await decideSending(ctx, plan.asset, part.stealth, p, opts);
        if (d.kind === "done") {
          await setJob(ctx, "quiet-part", row.job_key, { status: "done", ...(d.txHash ? { txHash: d.txHash } : {}), payload: { raw: null } });
          done.add(i);
        } else if (d.kind === "wait") {
          held.add(i);
          res.notes.push(`part ${i} of ${plan.asset}: ${d.note}`);
          if (d.payload) await setJob(ctx, "quiet-part", row.job_key, { status: "sending", payload: d.payload });
        } else resendFrom.set(i, p.fromBlock);
      }
    }
    doneByPlan.set(job_key, done);
    const skip = new Set([...done, ...held]);
    for (const i of releasable(plan, execCount, skip)) due.push({ key: job_key, plan, i, fromBlock: resendFrom.get(i) });
  }
  for (const { key, plan, i, fromBlock: earlier } of shuffle(due)) {
    const p = plan.parts[i]!;
    const partKey = `${key}:${i}`;
    const args = [plan.asset, p.stealth, BigInt(p.raw), p.ephemeralPublicKey, p.viewTag] as const;
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "deliverStealth", args);
    if (!sim.ok) {
      res.notes.push(`part ${i} of ${plan.asset}: deliverStealth reverts ${sim.errorName}`);
      continue;
    }
    // Credited logs are searched from the earliest block any attempt for this part was sent from.
    const fromBlock = earlier ?? (await ctx.pub.getBlockNumber()).toString();
    await setJob(ctx, "quiet-part", partKey, { status: "sending", payload: { fromBlock, stage: "signing", hash: null, nonce: null, raw: null, takenSeenAt: null } });
    const onSigned = async (tx: SignedTx) => {
      await setJob(ctx, "quiet-part", partKey, { status: "sending", payload: { stage: "signed", hash: tx.hash, nonce: tx.nonce, raw: tx.raw, takenSeenAt: null } });
    };
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliverStealth", args, "deliver-stealth", { onSigned });
    await setJob(ctx, "quiet-part", partKey, { status: "done", txHash: r.transactionHash, payload: { raw: null } });
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

export async function runDeliverQuiet(ctx: Ctx, opts: ReleaseOptions = {}): Promise<JobResult> {
  const res: JobResult = { job: "deliver-quiet", ok: true, actions: 0, notes: [] };
  if (!ctx.dep.stealthClaims) {
    res.notes.push("Quiet delivery not configured (no stealthClaims in deployment)");
    return res;
  }
  const execCount = await executions(ctx);
  await deliverPhase(ctx, res, execCount);
  await releasePhase(ctx, res, execCount, opts);
  return res;
}
