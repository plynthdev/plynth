// Job 4: JitterBeacon commit-reveal. For each asset with an open book, commit a fresh 32-byte secret for
// each of the next `lookahead` windows before they start; once a window has started, reveal its secret.
// The secret is generated with crypto.getRandomValues, sealed (AES-GCM, KEEPER_SECRET_KEY) and stored in
// keeper_jobs BEFORE the commit is sent, so a crash between the two never loses a committed secret.
// If the keeper misses a reveal, the beacon's fallback time (windowEnd - GRACE) still lets the book execute.
import { bytesToHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { beaconAbi, crowdAbi } from "@/abi/keeper";
import { chainNow, simulate, type Ctx, type JobResult } from "@/keeper/context";
import { newSecret } from "@/keeper/seal";
import { getJob, insertJobIfAbsent, setJob } from "@/keeper/jobstore";

/** CrowdBuy.windowOf: the fixed 24h grid from GENESIS. */
export function windowAt(t: bigint, genesis: bigint, window: bigint): { start: bigint; end: bigint } {
  if (t < genesis) throw new Error("before genesis");
  const start = genesis + ((t - genesis) / window) * window;
  return { start, end: start + window };
}

/** CrowdBuy.beaconKey: keccak256(abi.encode(asset, uint64 windowStart)). */
export function beaconKey(asset: Address, windowStart: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [asset, windowStart]));
}

/** JitterBeacon commitment: keccak256(abi.encode(secret, key)). */
export function commitmentOf(secret: Hex, key: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [secret, key]));
}

/** Window starts to commit for, given the current window start: the next `lookahead` windows. */
export function windowsToCommit(currentStart: bigint, window: bigint, lookahead: number): bigint[] {
  const out: bigint[] = [];
  for (let k = 1; k <= lookahead; k++) out.push(currentStart + BigInt(k) * window);
  return out;
}

/** A reveal is useful only inside [windowStart, windowEnd - GRACE); later the fallback time applies. */
export function revealOpen(now: bigint, start: bigint, end: bigint, grace: bigint): boolean {
  return now >= start && now < end - grace;
}

export type Timing = { genesis: bigint; window: bigint; grace: bigint };

export async function readTiming(ctx: Ctx): Promise<Timing> {
  const [genesis, window, grace] = await Promise.all([
    ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "GENESIS" }),
    ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "WINDOW" }),
    ctx.pub.readContract({ address: ctx.dep.beacon, abi: beaconAbi, functionName: "GRACE" }),
  ]);
  return { genesis: BigInt(genesis as bigint), window: BigInt(window as bigint), grace: BigInt(grace as bigint) };
}

type OnChain = { windowStart: bigint; windowEnd: bigint; executeAt: bigint; commitment: Hex };
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

async function onChain(ctx: Ctx, key: Hex): Promise<OnChain> {
  const b = (await ctx.pub.readContract({ address: ctx.dep.beacon, abi: beaconAbi, functionName: "beacon", args: [key] })) as OnChain;
  return { windowStart: BigInt(b.windowStart), windowEnd: BigInt(b.windowEnd), executeAt: BigInt(b.executeAt), commitment: b.commitment };
}

const aad = (ctx: Ctx, key: Hex) => `beacon:${ctx.chainId}:${key.toLowerCase()}`;

async function reveal(ctx: Ctx, res: JobResult, asset: Address, start: bigint, end: bigint, now: bigint, t: Timing) {
  const key = beaconKey(asset, start);
  const job = await getJob(ctx, "beacon", key.toLowerCase());
  if (!job || job.status === "revealed" || job.status === "expired" || job.status === "failed") return;
  const b = await onChain(ctx, key);
  if (b.commitment === ZERO32) {
    await setJob(ctx, "beacon", key.toLowerCase(), { status: "expired", payload: { why: "never committed before the window started" } });
    return;
  }
  if (b.executeAt !== 0n) {
    await setJob(ctx, "beacon", key.toLowerCase(), { status: "revealed", payload: { executeAt: b.executeAt } });
    return;
  }
  if (!revealOpen(now, start, end, t.grace)) {
    await setJob(ctx, "beacon", key.toLowerCase(), { status: "expired", payload: { why: "reveal window closed; fallback time applies" } });
    res.notes.push(`${asset} window ${start}: reveal missed, fallback ${end - t.grace}`);
    return;
  }
  const secret = bytesToHex(await ctx.sealer.open(job.secretEnc!, aad(ctx, key)));
  if (commitmentOf(secret, key).toLowerCase() !== b.commitment.toLowerCase()) {
    await setJob(ctx, "beacon", key.toLowerCase(), { status: "failed", error: "stored secret does not match the on-chain commitment" });
    res.notes.push(`${asset} window ${start}: commitment mismatch, fallback applies`);
    return;
  }
  const sim = await simulate(ctx, ctx.dep.beacon, beaconAbi, "reveal", [key, secret]);
  if (!sim.ok) {
    if (sim.errorName === "AlreadyRevealed") await setJob(ctx, "beacon", key.toLowerCase(), { status: "revealed" });
    else res.notes.push(`${asset} window ${start}: reveal reverts ${sim.errorName}`);
    return;
  }
  const r = await ctx.sender.sendCall(ctx.dep.beacon, beaconAbi, "reveal", [key, secret], "reveal");
  const after = await onChain(ctx, key);
  await setJob(ctx, "beacon", key.toLowerCase(), { status: "revealed", txHash: r.transactionHash, payload: { executeAt: after.executeAt } });
  res.actions++;
}

async function commit(ctx: Ctx, res: JobResult, asset: Address, ws: bigint, now: bigint, t: Timing) {
  if (now >= ws) return;
  const key = beaconKey(asset, ws);
  const b = await onChain(ctx, key);
  if (b.commitment !== ZERO32) {
    const job = await getJob(ctx, "beacon", key.toLowerCase());
    if (job && job.status === "secret") await setJob(ctx, "beacon", key.toLowerCase(), { status: "committed" });
    return;
  }
  let job = await getJob(ctx, "beacon", key.toLowerCase());
  if (!job) {
    const sealed = await ctx.sealer.seal(newSecret(), aad(ctx, key));
    job = await insertJobIfAbsent(ctx, "beacon", key.toLowerCase(), { status: "secret", secretEnc: sealed, payload: { asset, windowStart: ws, windowEnd: ws + t.window } });
  }
  const secret = bytesToHex(await ctx.sealer.open(job.secretEnc!, aad(ctx, key)));
  const args = [key, ws, ws + t.window, commitmentOf(secret, key)] as const;
  const sim = await simulate(ctx, ctx.dep.beacon, beaconAbi, "commit", args);
  if (!sim.ok) {
    res.notes.push(`${asset} window ${ws}: commit reverts ${sim.errorName}`);
    return;
  }
  const r = await ctx.sender.sendCall(ctx.dep.beacon, beaconAbi, "commit", args, "commit");
  await setJob(ctx, "beacon", key.toLowerCase(), { status: "committed", txHash: r.transactionHash });
  res.actions++;
}

export async function runBeacon(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "beacon", ok: true, actions: 0, notes: [] };
  const t = await readTiming(ctx);
  const now = await chainNow(ctx);
  if (now < t.genesis) return res;
  const { start, end } = windowAt(now, t.genesis, t.window);
  for (const asset of ctx.dep.stocks) {
    await reveal(ctx, res, asset, start, end, now, t);
    const [, book] = (await ctx.pub.readContract({ address: ctx.dep.crowd, abi: crowdAbi, functionName: "openBook", args: [asset] })) as readonly [bigint, { accounts: number }];
    if (Number(book.accounts) === 0) continue;
    for (const ws of windowsToCommit(start, t.window, ctx.lookahead)) await commit(ctx, res, asset, ws, now, t);
  }
  return res;
}
