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
// Proof of delivery: CrowdBuy.settled is also set by claimOpen (the user's ungated exit) and by a Hidden deliver,
// so "settled and a plan exists" proves nothing. Parts come out of the pool every Quiet user shares, so releasing
// them for a user whose allocation never went into it pays that user twice from other users' funds. A plan is
// promoted to "delivered" only on proof that OUR Quiet deliver settled it:
//   (a) the deliver transaction we signed (hash, nonce and bytes stored via onSigned before its broadcast) has a
//       successful receipt carrying Delivered(asset, bookId, user, raw) right after StealthClaims' Pooled(asset, raw);
//   (b) or, read pinned to the block where settled was seen true, a Delivered log for (asset, bookId, user) whose
//       transaction pooled the same raw into StealthClaims (a Hidden deliver emits Delivered too, but pools nothing).
// A Claimed log instead (the user claimed openly), or a Delivered that pooled nothing, marks the plan "skipped" and
// releases nothing. Neither log yet (a lagging node) waits. Before any part goes out, the delivered raw must equal
// plan.allocation and the parts must sum to it.
//
// Confirmations: every proof above (receipts, Delivered / Claimed / Credited logs, settled, the keeper's nonce) is
// read at head - KEEPER_CONFIRMATIONS (ctx.confirmations). A receipt or log above that block is "not yet": a reorg
// could still remove it, and a reorged-away Delivered must never release parts, nor a reorged-away Credited stop a
// part for good. A transaction mined above it stays "sending" / "planned" and is decided by a later pass. Before a
// plan's last part goes out, its proof is read again at the current confirmed block: if the Delivered is gone, the
// part waits (and if the allocation is no longer settled at all, the plan goes back to the deliver phase).
//
// Privacy note: the plan row links user to stealth addresses; it is scrubbed to amounts once every part is out.
import { computeStealthAddress } from "@plynth/sdk/stealth";
import { sql } from "drizzle-orm";
import { encodeAbiParameters, getAddress, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import { crowdAbi, stealthClaimsAbi, vaultAbi } from "@/abi/keeper";
import { confirmedBlock, simulate, type Ctx, type JobResult } from "@/keeper/context";
import { TxReverted, type SignedTx } from "@/keeper/sender";
import { getJob, insertJobIfAbsent, setJob } from "@/keeper/jobstore";

export const QUIET_ROUTE: Hex = encodeAbiParameters([{ type: "uint8" }], [1]);
export const DEFAULT_SPLIT_PARTS = 2;
const registryAbi = [parseAbiItem("function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)")] as const;
const creditedEvent = parseAbiItem("event Credited(address indexed token, address indexed stealth, uint256 raw)");
const deliveredEvent = parseAbiItem("event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)");
const claimedEvent = parseAbiItem("event Claimed(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)");
const pooledEvent = parseAbiItem("event Pooled(address indexed token, uint256 raw)");
const settlementEvents = [deliveredEvent, claimedEvent, pooledEvent] as const;

export type PlannedPart = { stealth: Address; ephemeralPublicKey: Hex; viewTag: Hex; raw: string; releaseAt: number };
/** Our deliver transaction, stored before its first broadcast (raw is dropped once it is proven). */
export type DeliverTx = { hash: Hex; nonce: number; raw: Hex | null };
/** Why the plan is "delivered": the settling transaction and the raw it pooled. */
export type DeliveryProof = { raw: string; tx: Hex; via: "receipt" | "log"; atBlock: string };
export type Plan = {
  asset: Address;
  bookId: string;
  user: Address;
  allocation: string;
  parts: PlannedPart[];
  deliverTx?: DeliverTx | null;
  delivered?: DeliveryProof;
};

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

/** The block the book executed in (from the indexer): settlement logs are searched from here. */
async function executedAt(ctx: Ctx, asset: Address, bookId: string): Promise<bigint> {
  const [r] = (await ctx.db.execute(sql`
    select min(block_number)::text as b from ev_logs
    where chain_id = ${ctx.chainId} and address = ${ctx.dep.crowd.toLowerCase()} and data_json->>'eventName' = 'Executed'
      and lower(data_json->'args'->>'asset') = ${asset.toLowerCase()} and data_json->'args'->>'bookId' = ${bookId}`)) as unknown as { b: string | null }[];
  return BigInt(r?.b ?? "0");
}

type Ev = { address: Address; eventName: string; args: Record<string, unknown>; transactionHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex };

/** How (asset, bookId, user) was settled, as far as the chain shows at the pinned block. */
export type Settlement =
  | { kind: "quiet"; raw: bigint; tx: Hex; via: "receipt" | "log" }
  | { kind: "claimed"; tx: Hex }
  | { kind: "other-route"; raw: bigint; tx: Hex }
  | { kind: "unknown"; note: string };

const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

/**
 * One transaction's logs: Claimed for this triple, or Delivered for it, which is Quiet only when the log right
 * before it is StealthClaims' Pooled(asset, raw) of the same transaction (raw 0 pools nothing: nothing to release).
 */
export function classifySettlement(logs: Ev[], crowd: Address, stealthClaims: Address, asset: Address, bookId: string, user: Address): Exclude<Settlement, { kind: "unknown" }> | undefined {
  const mine = (l: Ev) => same(l.address, crowd) && same(l.args.asset, asset) && String(l.args.bookId) === bookId && same(l.args.user, user);
  const claimed = logs.find((l) => l.eventName === "Claimed" && mine(l));
  if (claimed) return { kind: "claimed", tx: claimed.transactionHash };
  const d = logs.find((l) => l.eventName === "Delivered" && mine(l));
  if (!d) return undefined;
  const raw = BigInt(d.args.raw as bigint);
  if (raw === 0n) return { kind: "quiet", raw, tx: d.transactionHash, via: "log" };
  const pooled = logs.find(
    (l) => l.eventName === "Pooled" && same(l.address, stealthClaims) && l.transactionHash === d.transactionHash && Number(l.logIndex) === Number(d.logIndex) - 1 && same(l.args.token, asset) && BigInt(l.args.raw as bigint) === raw,
  );
  return pooled ? { kind: "quiet", raw, tx: d.transactionHash, via: "log" } : { kind: "other-route", raw, tx: d.transactionHash };
}

const RANGE_ERROR = /range|too many|more than|limit|exceed|10000|10,000/i;

/** getLogs over [from, to], split in halves when the node refuses the range. */
async function logsIn(ctx: Ctx, q: { address: Address; event: any; args: Record<string, unknown> }, from: bigint, to: bigint): Promise<Ev[]> {
  try {
    return (await ctx.pub.getLogs({ ...q, fromBlock: from, toBlock: to } as any)) as unknown as Ev[];
  } catch (err) {
    if (to - from < 2_000n || !RANGE_ERROR.test(String((err as Error)?.message ?? err))) throw err;
    const mid = from + (to - from) / 2n;
    return [...(await logsIn(ctx, q, from, mid)), ...(await logsIn(ctx, q, mid + 1n, to))];
  }
}

/**
 * Proof of how (asset, bookId, user) was settled: our stored deliver's receipt first (only when it is at or below
 * `atBlock`, the confirmed block), else the settlement logs from the book's execution up to `atBlock` (the block where
 * settled was read true, so one of them is there; a node without that block errors instead of answering from the past).
 */
export async function proveSettlement(ctx: Ctx, plan: Plan, fromBlock: bigint, atBlock: bigint): Promise<Settlement> {
  const { asset, bookId, user } = plan;
  const sc = ctx.dep.stealthClaims!;
  if (plan.deliverTx?.hash) {
    const r = await ctx.sender.receiptOf(plan.deliverTx.hash);
    if (r && r.status === "success" && r.blockNumber <= atBlock) {
      const s = classifySettlement(parseEventLogs({ abi: settlementEvents, logs: r.logs }) as unknown as Ev[], ctx.dep.crowd, sc, asset, bookId, user);
      if (s?.kind === "quiet") return { ...s, via: "receipt" };
    }
  }
  const args = { asset, bookId: BigInt(bookId), user };
  const delivered = await logsIn(ctx, { address: ctx.dep.crowd, event: deliveredEvent, args }, fromBlock, atBlock);
  const claimed = await logsIn(ctx, { address: ctx.dep.crowd, event: claimedEvent, args }, fromBlock, atBlock);
  if (delivered.length + claimed.length > 1) return { kind: "unknown", note: `${delivered.length} Delivered + ${claimed.length} Claimed logs for one settlement; check by hand` };
  if (claimed[0]) return classifySettlement(claimed, ctx.dep.crowd, sc, asset, bookId, user)!;
  const d = delivered[0];
  if (!d) return { kind: "unknown", note: `settled at block ${atBlock} but no Delivered or Claimed log up to it yet (lagging node?)` };
  // Pinned by block HASH: a node without that block errors instead of returning no Pooled log, which would read as
  // "another route" and skip a plan whose allocation really is in the pool.
  const pooled = (await ctx.pub.getLogs({ address: sc, event: pooledEvent, args: { token: asset }, blockHash: d.blockHash })) as unknown as Ev[];
  return classifySettlement([...pooled, d], ctx.dep.crowd, sc, asset, bookId, user)!;
}

const scrubbed = (plan: Plan) => plan.parts.map((p) => ({ raw: p.raw, releaseAt: p.releaseAt }));

/** Applies a settlement proof to a plan row. Returns true when the plan may release parts. */
async function recordSettlement(ctx: Ctx, res: JobResult, key: string, plan: Plan, s: Settlement, atBlock: bigint): Promise<boolean> {
  const tag = `${plan.user} ${plan.asset} book ${plan.bookId}`;
  const deliverTx = plan.deliverTx ? { ...plan.deliverTx, raw: null } : null;
  switch (s.kind) {
    case "quiet": {
      const delivered: DeliveryProof = { raw: s.raw.toString(), tx: s.tx, via: s.via, atBlock: atBlock.toString() };
      await setJob(ctx, "quiet-plan", key, { status: "delivered", txHash: s.tx, payload: { delivered, deliverTx } });
      plan.delivered = delivered;
      return true;
    }
    case "claimed":
      await setJob(ctx, "quiet-plan", key, { status: "skipped", payload: { reason: `claimed openly (tx ${s.tx})`, parts: scrubbed(plan), deliverTx } });
      res.notes.push(`${tag}: claimed openly; Quiet plan skipped, nothing released`);
      return false;
    case "other-route":
      await setJob(ctx, "quiet-plan", key, { status: "skipped", payload: { reason: `settled by a deliver that pooled nothing into StealthClaims (tx ${s.tx})`, parts: scrubbed(plan), deliverTx } });
      res.notes.push(`${tag}: settled by another route; Quiet plan skipped, nothing released`);
      return false;
    case "unknown":
      res.notes.push(`${tag}: ${s.note}`);
      return false;
  }
}

/** The rule before any part goes out: the proven delivered raw equals plan.allocation and the parts sum to it. */
export function releaseCheck(plan: Plan): { ok: true } | { ok: false; reason: string } {
  if (!plan.delivered) return { ok: false, reason: "no delivery proof" };
  const raw = BigInt(plan.delivered.raw);
  const sum = plan.parts.reduce((a, p) => a + BigInt(p.raw), 0n);
  if (raw !== BigInt(plan.allocation)) return { ok: false, reason: `delivered raw ${raw} != planned allocation ${plan.allocation}` };
  if (sum !== raw) return { ok: false, reason: `parts sum ${sum} != delivered raw ${raw}` };
  return { ok: true };
}

async function deliverPhase(ctx: Ctx, res: JobResult, execCount: number): Promise<void> {
  const n = ctx.splitParts ?? DEFAULT_SPLIT_PARTS;
  const list = await candidates(ctx);
  if (list.length === 0) return;
  // Every read of this phase is pinned to one confirmed block (head - confirmations): settled and the settlement logs
  // agree with each other, and nothing a reorg can still remove counts.
  const { at: atBlock } = await confirmedBlock(ctx);
  for (const { asset, bookId, user } of list) {
    const key = planKey(asset, bookId, user);
    const settled = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "settled", args: [asset, BigInt(bookId), user], blockNumber: atBlock })) as boolean;
    const existing = await getJob(ctx, "quiet-plan", key);
    let plan = existing?.payload as Plan | undefined;
    if (settled) {
      if (!plan) {
        await setJob(ctx, "quiet-plan", key, { status: "skipped", payload: { reason: "settled without Quiet delivery (claimed openly or cancelled)" } });
        continue;
      }
      // NOT proof that our deliver landed: claimOpen and a Hidden deliver set settled too.
      await recordSettlement(ctx, res, key, plan, await proveSettlement(ctx, plan, await executedAt(ctx, asset, bookId), atBlock), atBlock);
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
    if (!plan) {
      const allocation = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "allocationOf", args: [asset, BigInt(bookId), user] })) as bigint;
      const parts = splitAmount(allocation, n).map((raw, i): PlannedPart => {
        const g = computeStealthAddress(meta);
        return { stealth: g.stealthAddress, ephemeralPublicKey: g.ephemeralPublicKey, viewTag: g.viewTag, raw: raw.toString(), releaseAt: execCount + i };
      });
      plan = (await insertJobIfAbsent(ctx, "quiet-plan", key, { status: "planned", payload: { asset, bookId, user, allocation: allocation.toString(), parts } satisfies Plan })).payload as Plan;
    }
    const prior = plan.deliverTx;
    if (prior?.hash) {
      // An earlier deliver of ours: while it may still mine, keep its bytes alive instead of signing another. A
      // second deliver could never pay twice (it reverts AlreadySettled) but it would only waste gas.
      const r = await ctx.sender.receiptOf(prior.hash);
      if (r && r.blockNumber > atBlock) {
        res.notes.push(`${user} ${asset} book ${bookId}: deliver ${prior.hash} mined at block ${r.blockNumber}, above the confirmed block ${atBlock}; proven once confirmed`);
        continue;
      }
      if (r?.status === "success") {
        res.notes.push(`${user} ${asset} book ${bookId}: deliver ${prior.hash} mined after block ${atBlock}; proven next pass`);
        continue;
      }
      if (!r) {
        const confirmed = await ctx.pub.getTransactionCount({ address: ctx.sender.address, blockNumber: atBlock });
        if (confirmed <= prior.nonce) {
          if (prior.raw) await ctx.sender.rebroadcast(prior.raw);
          res.notes.push(`${user} ${asset} book ${bookId}: deliver ${prior.hash} (nonce ${prior.nonce}) still pending`);
          continue;
        }
      }
      // It reverted, or another transaction took its nonce: it can never settle anything. Send a new one.
    }
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "deliver", [asset, BigInt(bookId), user, QUIET_ROUTE]);
    if (!sim.ok) {
      res.notes.push(`${user} ${asset} book ${bookId}: deliver reverts ${sim.errorName}`);
      continue;
    }
    const onSigned = async (tx: SignedTx) => {
      await setJob(ctx, "quiet-plan", key, { status: "planned", payload: { deliverTx: { hash: tx.hash, nonce: tx.nonce, raw: tx.raw } } });
      plan!.deliverTx = { hash: tx.hash, nonce: tx.nonce, raw: tx.raw };
    };
    let receipt;
    try {
      receipt = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliver", [asset, BigInt(bookId), user, QUIET_ROUTE], "deliver-quiet", { onSigned });
    } catch (err) {
      if (!(err instanceof TxReverted)) throw err; // TxUnconfirmed / transport: the next pass decides from the stored tx
      res.notes.push(`${user} ${asset} book ${bookId}: deliver ${err.hash} reverted; the next pass checks how it was settled`);
      continue;
    }
    const confirmed = (await confirmedBlock(ctx)).at;
    if (receipt.blockNumber > confirmed) {
      // Mined, but a reorg can still remove it: a later pass proves it from the stored transaction once confirmed.
      res.notes.push(`${user} ${asset} book ${bookId}: deliver ${receipt.transactionHash} mined at block ${receipt.blockNumber}; proven once confirmed`);
      res.actions++;
      continue;
    }
    const s = classifySettlement(parseEventLogs({ abi: settlementEvents, logs: receipt.logs }) as unknown as Ev[], ctx.dep.crowd, ctx.dep.stealthClaims!, asset, bookId, user);
    if (s?.kind === "quiet") {
      await recordSettlement(ctx, res, key, plan, { ...s, via: "receipt" }, receipt.blockNumber);
      res.actions++;
    } else res.notes.push(`${user} ${asset} book ${bookId}: deliver ${receipt.transactionHash} mined without a Quiet Delivered log; the next pass checks the logs`);
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
  const { at } = await confirmedBlock(ctx);
  const conf = ctx.confirmations ?? 0;
  if (await alreadyCredited(ctx, asset, stealth, fromBlock)) {
    // Credited at the head; done only once that credit is at or below the confirmed block.
    if (conf === 0 || (await alreadyCredited(ctx, asset, stealth, fromBlock, at))) return { kind: "done", ...(p.hash ? { txHash: p.hash } : {}) };
    return { kind: "wait", note: `stealth ${stealth}: credited above the confirmed block ${at}; done once confirmed` };
  }
  if (p.stage === "signing") return { kind: "resend" }; // marked, but nothing was signed or broadcast
  if (p.stage !== "signed" || !p.hash || p.nonce === undefined) {
    return { kind: "wait", note: `stealth ${stealth}: "sending" without a recorded transaction (older keeper); check StealthClaims by hand, then mark it done or delete the row` };
  }
  const receipt = await ctx.sender.receiptOf(p.hash);
  // A receipt above the confirmed block can still be reorged away (a success) or turn into a success (a revert).
  if (receipt && receipt.blockNumber > at) return { kind: "wait", note: `stealth ${stealth}: tx ${p.hash} mined at block ${receipt.blockNumber}, above the confirmed block ${at}` };
  if (receipt) return receipt.status === "success" ? { kind: "done", txHash: p.hash } : { kind: "resend" };
  const confirmed = await ctx.pub.getTransactionCount({ address: ctx.sender.address, blockNumber: at });
  if (confirmed <= p.nonce) {
    if (p.raw) await ctx.sender.rebroadcast(p.raw);
    return { kind: "wait", note: `stealth ${stealth}: tx ${p.hash} (nonce ${p.nonce}) still pending`, ...(p.takenSeenAt ? { payload: { takenSeenAt: null } } : {}) };
  }
  // Our nonce is used and our hash has no receipt: another transaction took it, or a lagging node is hiding ours.
  const now = (opts.now ?? Date.now)();
  if (!p.takenSeenAt) return { kind: "wait", note: `stealth ${stealth}: nonce ${p.nonce} used, no receipt for ${p.hash} yet; re-checking later`, payload: { takenSeenAt: now } };
  if (now - p.takenSeenAt < (opts.takenGraceMs ?? TAKEN_GRACE_MS)) return { kind: "wait", note: `stealth ${stealth}: nonce ${p.nonce} used, waiting out the grace period` };
  // Pinned to the confirmed block: a node that does not have that block errors instead of answering from the past.
  if (await alreadyCredited(ctx, asset, stealth, fromBlock, at)) return { kind: "done", txHash: p.hash };
  return { kind: "resend" };
}

/**
 * Before a plan's last part goes out: its delivery proof again, at the current confirmed block. True when the same
 * Quiet delivery (same raw) is still there. A proof already read at this block or later is not read again.
 */
export async function recheckProof(ctx: Ctx, res: JobResult, key: string, plan: Plan, atBlock: bigint): Promise<boolean> {
  const proof = plan.delivered!;
  if (BigInt(proof.atBlock) >= atBlock) return true;
  const s = await proveSettlement(ctx, plan, await executedAt(ctx, plan.asset, plan.bookId), atBlock);
  if (s.kind === "quiet" && s.raw.toString() === proof.raw) {
    const delivered: DeliveryProof = { raw: proof.raw, tx: s.tx, via: s.via, atBlock: atBlock.toString() };
    await setJob(ctx, "quiet-plan", key, { status: "delivered", txHash: s.tx, payload: { delivered } });
    plan.delivered = delivered;
    return true;
  }
  if (s.kind === "unknown") {
    const settled = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "settled", args: [plan.asset, BigInt(plan.bookId), plan.user], blockNumber: atBlock })) as boolean;
    if (!settled) {
      // The deliver that proved it was reorged away: back to the deliver phase, which re-sends or re-proves it.
      await setJob(ctx, "quiet-plan", key, { status: "planned", payload: { delivered: null } });
      res.notes.push(`plan ${key}: its Quiet deliver ${proof.tx} is no longer on the chain at the confirmed block ${atBlock} (reorg); last part held, plan back to the deliver phase`);
      return false;
    }
    res.notes.push(`plan ${key}: ${s.note}; last part held`);
    return false;
  }
  res.notes.push(`plan ${key}: the proof changed at block ${atBlock} (${s.kind}${s.kind === "quiet" ? ` raw ${s.raw}` : ""}, was our Quiet deliver ${proof.tx} raw ${proof.raw}); last part held for a manual check`);
  return false;
}

export async function releasePhase(ctx: Ctx, res: JobResult, execCount: number, opts: ReleaseOptions = {}): Promise<void> {
  const plans = (await ctx.db.execute(sql`
    select job_key, payload from keeper_jobs where chain_id = ${ctx.chainId} and kind = 'quiet-plan' and status = 'delivered'`)) as unknown as { job_key: string; payload: Plan }[];
  type Item = { key: string; plan: Plan; i: number; fromBlock?: string | undefined };
  const due: Item[] = [];
  const doneByPlan = new Map<string, Set<number>>();
  const blocked = new Set<string>();
  let atBlock: bigint | undefined;
  for (const { job_key, payload: plan } of plans) {
    if (!plan.delivered) {
      // Promoted by an older keeper on "settled and a plan exists", which is no proof: prove it now.
      atBlock ??= (await confirmedBlock(ctx)).at;
      const s = await proveSettlement(ctx, plan, await executedAt(ctx, plan.asset, plan.bookId), atBlock);
      const anyPart = s.kind === "claimed" || s.kind === "other-route" ? ((await ctx.db.execute(sql`select 1 from keeper_jobs where chain_id = ${ctx.chainId} and kind = 'quiet-part' and job_key like ${`${job_key}:%`} limit 1`)) as unknown as unknown[]).length > 0 : false;
      if (anyPart) {
        res.notes.push(`plan ${job_key}: parts were sent but the settlement was not our Quiet deliver (${s.kind}); held for a manual check`);
        blocked.add(job_key);
        continue;
      }
      if (!(await recordSettlement(ctx, res, job_key, plan, s, atBlock))) {
        blocked.add(job_key);
        continue;
      }
    }
    const check = releaseCheck(plan);
    if (!check.ok) {
      res.notes.push(`plan ${job_key}: ${check.reason}; nothing released (check by hand)`);
      blocked.add(job_key);
      continue;
    }
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
    const dueNow = releasable(plan, execCount, skip);
    if (dueNow.length > 0 && done.size + dueNow.length === plan.parts.length) {
      // This pass would release the plan's last part: read its proof once more at the current confirmed block.
      atBlock ??= (await confirmedBlock(ctx)).at;
      if (!(await recheckProof(ctx, res, job_key, plan, atBlock))) {
        blocked.add(job_key);
        continue;
      }
    }
    for (const i of dueNow) due.push({ key: job_key, plan, i, fromBlock: resendFrom.get(i) });
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
    // Credited logs are searched from the earliest block any attempt for this part was sent from (the confirmed block:
    // after a reorg the transaction can mine below the head it was sent at).
    const fromBlock = earlier ?? (await confirmedBlock(ctx)).at.toString();
    await setJob(ctx, "quiet-part", partKey, { status: "sending", payload: { fromBlock, stage: "signing", hash: null, nonce: null, raw: null, takenSeenAt: null } });
    const onSigned = async (tx: SignedTx) => {
      await setJob(ctx, "quiet-part", partKey, { status: "sending", payload: { stage: "signed", hash: tx.hash, nonce: tx.nonce, raw: tx.raw, takenSeenAt: null } });
    };
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliverStealth", args, "deliver-stealth", { onSigned });
    res.actions++;
    if (r.blockNumber > (await confirmedBlock(ctx)).at) {
      // Mined but not confirmed: the row stays "sending" with its stored transaction; a later pass marks it done.
      res.notes.push(`part ${i} of ${plan.asset}: tx ${r.transactionHash} mined at block ${r.blockNumber}; done once confirmed`);
      continue;
    }
    await setJob(ctx, "quiet-part", partKey, { status: "done", txHash: r.transactionHash, payload: { raw: null } });
    doneByPlan.get(key)!.add(i);
  }
  for (const { job_key, payload: plan } of plans) {
    if (blocked.has(job_key)) continue;
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
