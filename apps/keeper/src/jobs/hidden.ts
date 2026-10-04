// Job 7: deliver-hidden. For every executed book, every joined user whose vault mode is Hidden (2) and who
// registered hidden keys (SavingsVault.setHiddenKeys):
//   crowd.deliver(asset, bookId, user, abi.encode(uint8 2, blinding, encryptedNote))
// CrowdBuy settles the allocation and calls ShieldedPool.depositFor with the ownerPk from the vault, so the
// keeper only chooses the blinding (fresh random field element) and encrypts the note to the user's viewing
// key. The user is the deposit's origin: if the note does not open for them, they refund it while pending.
// Then, as a public service, it batches deposits whose MIN_PENDING_DELAY has passed into the tree
// (insertPending; anyone may call it, users' own deposits included).
// Nothing secret is stored: the row keeps (asset, book, user, raw, commitment), all public in DepositQueued.
import { commitmentOf, encryptNote, initVault, randomField, shieldedPoolAbi, toBytes32 } from "@plynth/sdk/vault";
import { sql } from "drizzle-orm";
import { encodeAbiParameters, getAddress, hexToBytes, type Address, type Hex } from "viem";
import { crowdAbi, vaultAbi } from "../abi";
import { simulate, type Ctx, type JobResult } from "../context";

export const MODE_HIDDEN = 2;
/** Deposits inserted per insertPending transaction (each leaf is ~1.2M gas). */
export const INSERT_BATCH = 8n;

export function hiddenRoute(blinding: bigint, encryptedNote: Hex): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes" }], [MODE_HIDDEN, toBytes32(blinding), encryptedNote]);
}

/** Builds the route for `user` (random blinding, note encrypted to their viewing key) and the note commitment. */
export function planHiddenNote(asset: Address, raw: bigint, ownerPk: bigint, viewingPub: Uint8Array) {
  const blinding = randomField();
  const note = encryptNote({ asset, raw, blinding }, viewingPub);
  return { route: hiddenRoute(blinding, note), commitment: commitmentOf(BigInt(asset), raw, ownerPk, blinding) };
}

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
        select 1 from keeper_hidden_deliveries k
        where k.chain_id = j.chain_id and k.asset = lower(j.data_json->'args'->>'asset')
          and k.book_id = (j.data_json->'args'->>'bookId')::numeric and k.user_address = lower(j.data_json->'args'->>'user'))
    order by 1, 2, 3`)) as unknown as { asset: string; book_id: string; u: string }[];
  return rows.map((r) => ({ asset: getAddress(r.asset), bookId: r.book_id, user: getAddress(r.u) }));
}

async function record(ctx: Ctx, asset: Address, bookId: string, user: Address, v: { status: string; reason?: string; raw?: bigint; commitment?: bigint; txHash?: Hex }) {
  await ctx.db.execute(sql`
    insert into keeper_hidden_deliveries (chain_id, asset, book_id, user_address, raw, commitment, status, reason, tx_hash)
    values (${ctx.chainId}, ${asset.toLowerCase()}, ${bookId}, ${user.toLowerCase()}, ${v.raw?.toString() ?? null},
            ${v.commitment === undefined ? null : toBytes32(v.commitment)}, ${v.status}, ${v.reason ?? null}, ${v.txHash ?? null})
    on conflict (chain_id, asset, book_id, user_address) do update set status = excluded.status, reason = excluded.reason,
      raw = coalesce(excluded.raw, keeper_hidden_deliveries.raw), commitment = coalesce(excluded.commitment, keeper_hidden_deliveries.commitment),
      tx_hash = coalesce(excluded.tx_hash, keeper_hidden_deliveries.tx_hash), updated_at = now()`);
}

async function deliverPhase(ctx: Ctx, res: JobResult): Promise<void> {
  for (const { asset, bookId, user } of await candidates(ctx)) {
    const read = (functionName: string, args: readonly unknown[], address = ctx.dep.crowd, abi: any = crowdAbi) =>
      ctx.pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;
    if (await read("settled", [asset, BigInt(bookId), user])) {
      await record(ctx, asset, bookId, user, { status: "skipped", reason: "already settled (claimed openly or delivered)" });
      continue;
    }
    if ((await read("orderOf", [asset, BigInt(bookId), user])) === 0n) {
      await record(ctx, asset, bookId, user, { status: "skipped", reason: "no order (cancelled)" });
      continue;
    }
    const mode = Number((await read("settingsOf", [user], ctx.dep.vault, vaultAbi)).mode);
    if (mode !== MODE_HIDDEN) continue; // re-checked every pass: the user may switch to Hidden before claiming
    const keys = (await read("hiddenKeysOf", [user], ctx.dep.vault, vaultAbi)) as { ownerPk: Hex; viewingPub: Hex };
    if (BigInt(keys.ownerPk) === 0n) {
      res.notes.push(`${user}: Hidden but no registered hidden keys`);
      continue;
    }
    const raw = (await read("allocationOf", [asset, BigInt(bookId), user])) as bigint;
    const plan = planHiddenNote(asset, raw, BigInt(keys.ownerPk), hexToBytes(keys.viewingPub));
    const args = [asset, BigInt(bookId), user, plan.route] as const;
    const sim = await simulate(ctx, ctx.dep.crowd, crowdAbi, "deliver", args);
    if (!sim.ok) {
      res.notes.push(`${user} ${asset} book ${bookId}: deliver reverts ${sim.errorName}`);
      continue;
    }
    const r = await ctx.sender.sendCall(ctx.dep.crowd, crowdAbi, "deliver", args, "deliver-hidden");
    await record(ctx, asset, bookId, user, { status: "delivered", raw, commitment: plan.commitment, txHash: r.transactionHash });
    res.actions++;
  }
}

async function insertPhase(ctx: Ctx, res: JobResult): Promise<void> {
  const pool = ctx.dep.shieldedPool!;
  const ready = (await ctx.pub.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "readyCount", args: [256n] })) as bigint;
  if (ready === 0n) return;
  const sim = await simulate(ctx, pool, shieldedPoolAbi, "insertPending", [INSERT_BATCH]);
  if (!sim.ok) {
    res.notes.push(`insertPending reverts ${sim.errorName}`);
    return;
  }
  await ctx.sender.sendCall(pool, shieldedPoolAbi, "insertPending", [INSERT_BATCH], "insert-pending");
  res.actions++;
}

export async function runDeliverHidden(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { job: "deliver-hidden", ok: true, actions: 0, notes: [] };
  if (!ctx.dep.shieldedPool) {
    res.notes.push("Hidden delivery not configured (no shieldedPool in deployment)");
    return res;
  }
  await initVault();
  await deliverPhase(ctx, res);
  await insertPhase(ctx, res);
  return res;
}
