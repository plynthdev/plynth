// deliver-quiet releases stealth parts only after OUR Quiet deliver is proven. CrowdBuy.settled is also set by the
// user's own claimOpen (always allowed) and by a Hidden deliver, and the parts come out of StealthClaims' pool that
// every Quiet user shares, so "settled + a plan exists" must never be read as "delivered": that pays the user twice,
// the second time from other users' allocations. Real Postgres job rows + the real Sender over a fake CrowdBuy /
// StealthClaims that can fail a simulate, hold a transaction pending, lose a receipt, or kill the process before a
// broadcast, while users claim openly in between.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeys, metaAddressBytes } from "@plynth/sdk/stealth";
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  hexToString,
  keccak256,
  parseAbiItem,
  toHex,
  type AbiEvent,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { crowdAbi, errorsAbi } from "@/abi/keeper";
import type { Ctx, JobResult, KeeperDeployment } from "@/keeper/context";
import { getJob, setJob } from "@/keeper/jobstore";
import { Sender, TxUnconfirmed, type SenderIO } from "@/keeper/sender";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runDeliverQuiet, type Plan } from "./quiet";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const KEEPER = A(0xaa);
const CROWD = A(0xc0);
const CLAIMS = A(0xc1);
const VAULT = A(0xc2);
const REGISTRY = A(0xc3);
const SHIELDED = A(0xc4);
const ASSET = A(0x7e);
const VICTIM = A(0x11); // sorts first: delivered normally, owed parts from the pool
const USER = A(0x22); // the user whose deliver does not land, then claims openly
const META = metaAddressBytes(generateKeys(`0x${"ab".repeat(32)}${"cd".repeat(32)}1b` as Hex));

const ev = {
  Delivered: parseAbiItem("event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)"),
  Claimed: parseAbiItem("event Claimed(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)"),
  Pooled: parseAbiItem("event Pooled(address indexed token, uint256 raw)"),
  Credited: parseAbiItem("event Credited(address indexed token, address indexed stealth, uint256 raw)"),
  Deposited: parseAbiItem("event Deposited(address indexed token, uint256 raw)"),
} as const;

type Log = { address: Address; eventName: string; args: Record<string, unknown>; transactionHash: Hash; logIndex: number; blockNumber: bigint; blockHash: Hash; topics: Hex[]; data: Hex };
const blockHash = (n: bigint) => keccak256(toHex(`block-${n}`));

function revert(errorName: string, args: readonly unknown[] = []): never {
  throw new ContractFunctionRevertedError({ abi: errorsAbi as any, data: encodeErrorResult({ abi: errorsAbi as any, errorName, args } as any), functionName: "x" });
}

/** A CrowdBuy book (asset, book 0) + StealthClaims, as one keeper key and its users see them. */
class FakeCrowd {
  head = 100n;
  nonce = 0;
  pool = new Map<number, { raw: Hex; hash: Hash; data: Hex }>();
  receipts = new Map<Hash, { status: "success" | "reverted"; blockNumber: bigint; logs: Log[] }>();
  signed: { hash: Hash; fn: string }[] = [];
  fee = 30n;
  autoMine = true;
  /** The node never returns a receipt for keeper transactions (lost): the job must find the logs. */
  loseReceipts = false;
  killNextBroadcast = false;
  simFail = new Map<string, string>(); // user -> error name the deliver simulate reverts with
  alloc = new Map<string, bigint>([[VICTIM.toLowerCase(), 600n], [USER.toLowerCase(), 400n]]);
  mode = new Map<string, number>();
  settledAt = new Map<string, bigint>();
  pooled = 0n;
  credits: { stealth: string; raw: bigint; block: bigint }[] = [];
  paidOpen = new Map<string, bigint>();
  logs: Log[] = [];
  /** Blocks the log node serving a by-hash query does not have (a load-balanced RPC behind on one backend). */
  unknownBlocks = new Set<Hash>();
  private txn = 0;

  emit(txHash: Hash, address: Address, event: AbiEvent, args: Record<string, unknown>, logIndex: number): Log {
    const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as any) as Hex[];
    const plain = event.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
    const l: Log = { address, eventName: event.name, args, transactionHash: txHash, logIndex, blockNumber: this.head, blockHash: blockHash(this.head), topics, data };
    this.logs.push(l);
    return l;
  }

  settled(user: Address, at = this.head) {
    const s = this.settledAt.get(user.toLowerCase());
    return s !== undefined && s <= at;
  }

  private settle(user: Address) {
    if (this.settled(user)) return false;
    this.settledAt.set(user.toLowerCase(), this.head);
    return true;
  }

  /** The user's ungated exit: their whole allocation to their wallet. */
  claimOpen(user: Address) {
    this.head++;
    const hash = keccak256(toHex(`claim-${this.txn++}`));
    if (!this.settle(user)) throw new Error("AlreadySettled");
    const raw = this.alloc.get(user.toLowerCase())!;
    this.paidOpen.set(user.toLowerCase(), (this.paidOpen.get(user.toLowerCase()) ?? 0n) + raw);
    this.emit(hash, ASSET, parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), { from: CROWD, to: user, value: raw }, 0);
    this.emit(hash, CROWD, ev.Claimed, { asset: ASSET, bookId: 0n, user, raw }, 1);
  }

  /** Another keeper path (Hidden) settles the user: Delivered, but nothing pooled into StealthClaims. */
  deliverHidden(user: Address) {
    this.head++;
    const hash = keccak256(toHex(`hidden-${this.txn++}`));
    this.settle(user);
    const raw = this.alloc.get(user.toLowerCase())!;
    this.emit(hash, SHIELDED, ev.Deposited, { token: ASSET, raw }, 1);
    this.emit(hash, CROWD, ev.Delivered, { asset: ASSET, bookId: 0n, user, raw }, 2);
  }

  /** What a mined keeper transaction does on CrowdBuy. */
  private apply(hash: Hash, data: Hex): { ok: boolean; logs: Log[] } {
    const { functionName, args } = decodeFunctionData({ abi: crowdAbi, data }) as { functionName: string; args: readonly any[] };
    if (functionName === "deliver") {
      const user = args[2] as Address;
      if (!this.settle(user)) return { ok: false, logs: [] }; // AlreadySettled
      const raw = this.alloc.get(user.toLowerCase())!;
      this.pooled += raw;
      return {
        ok: true,
        logs: [
          this.emit(hash, ASSET, parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), { from: CROWD, to: CLAIMS, value: raw }, 0),
          this.emit(hash, CLAIMS, ev.Pooled, { token: ASSET, raw }, 1),
          this.emit(hash, CROWD, ev.Delivered, { asset: ASSET, bookId: 0n, user, raw }, 2),
        ],
      };
    }
    if (functionName === "deliverStealth") {
      const raw = args[2] as bigint;
      if (this.pooled < raw) return { ok: false, logs: [] }; // PoolTooSmall
      this.pooled -= raw;
      this.credits.push({ stealth: String(args[1]).toLowerCase(), raw, block: this.head });
      return { ok: true, logs: [this.emit(hash, CLAIMS, ev.Credited, { token: ASSET, stealth: args[1], raw }, 0)] };
    }
    throw new Error(`unexpected ${functionName}`);
  }

  /**
   * A reorg deeper than the keeper's confirmations removes these mined transactions (a deliver and the credits of
   * its parts): their receipts and logs vanish and their effects are undone. The nonces stay used (other keeper
   * transactions took them on the new branch).
   */
  reorgOut(hashes: Hash[]) {
    for (const hash of hashes) {
      this.receipts.delete(hash);
      const gone = this.logs.filter((l) => l.transactionHash === hash);
      this.logs = this.logs.filter((l) => l.transactionHash !== hash);
      for (const l of gone) {
        if (l.eventName === "Delivered") {
          this.settledAt.delete(String(l.args.user).toLowerCase());
          this.pooled -= l.args.raw as bigint;
        }
        if (l.eventName === "Credited") {
          const i = this.credits.findIndex((c) => c.stealth === String(l.args.stealth).toLowerCase() && c.raw === l.args.raw);
          this.credits.splice(i, 1);
          this.pooled += l.args.raw as bigint;
        }
      }
    }
  }

  mine() {
    const tx = this.pool.get(this.nonce);
    if (!tx) return false;
    this.pool.delete(this.nonce);
    this.head++;
    this.nonce++;
    const r = this.apply(tx.hash, tx.data);
    this.receipts.set(tx.hash, { status: r.ok ? "success" : "reverted", blockNumber: this.head, logs: r.ok ? r.logs : [] });
    return true;
  }

  deliversSigned() {
    return this.signed.filter((s) => s.fn === "deliver").length;
  }
  creditedTotal() {
    return this.credits.reduce((a, c) => a + c.raw, 0n);
  }

  io(): SenderIO {
    return {
      estimateGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: this.fee++, maxPriorityFeePerGas: 2n }),
      getTransactionCount: async ({ blockTag }) => (blockTag === "pending" ? this.nonce + this.pool.size : this.nonce),
      signTransaction: async (tx) => {
        const raw = toHex(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        this.signed.push({ hash: keccak256(raw), fn: decodeFunctionData({ abi: crowdAbi, data: tx.data }).functionName });
        return raw;
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        if (this.killNextBroadcast) {
          this.killNextBroadcast = false;
          throw new Error("process killed before the broadcast left");
        }
        const hash = keccak256(serializedTransaction);
        const j = JSON.parse(hexToString(serializedTransaction)) as { nonce: number; data: Hex };
        if (this.receipts.has(hash) || [...this.pool.values()].some((t) => t.hash === hash)) throw new Error("already known");
        if (j.nonce < this.nonce) throw new Error(`nonce too low: next nonce ${this.nonce}`);
        if (this.pool.has(j.nonce)) throw new Error("replacement transaction underpriced");
        this.pool.set(j.nonce, { raw: serializedTransaction, hash, data: j.data });
        if (this.autoMine) while (this.mine());
        return hash;
      },
      getTransactionReceipt: async ({ hash }) => {
        const r = this.receipts.get(hash);
        if (!r || this.loseReceipts) return null;
        return { transactionHash: hash, status: r.status, blockNumber: r.blockNumber, logs: r.logs } as unknown as TransactionReceipt;
      },
    };
  }

  pub(): PublicClient {
    const match = (l: Log, args: Record<string, unknown> | undefined) =>
      Object.entries(args ?? {}).every(([k, v]) => (typeof v === "string" ? String(l.args[k]).toLowerCase() === v.toLowerCase() : l.args[k] === v));
    return {
      getBlockNumber: async () => this.head,
      getTransactionCount: async () => this.nonce,
      simulateContract: async ({ functionName, args }: { functionName: string; args: readonly any[] }) => {
        if (functionName === "deliver") {
          const f = this.simFail.get(String(args[2]).toLowerCase());
          if (f) revert(f);
          if (this.settled(args[2])) revert("AlreadySettled");
        }
        if (functionName === "deliverStealth" && this.pooled < (args[2] as bigint)) revert("PoolTooSmall", [this.pooled, args[2]]);
        return { result: undefined };
      },
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly any[]; blockNumber?: bigint }) => {
        if (blockNumber !== undefined && blockNumber > this.head) throw new Error(`header not found (block ${blockNumber})`);
        switch (functionName) {
          case "settled":
            return this.settled(args[2], blockNumber ?? this.head);
          case "orderOf":
            return 1n;
          case "allocationOf":
            return this.alloc.get(String(args[2]).toLowerCase())!;
          case "settingsOf":
            return { mode: this.mode.get(String(args[0]).toLowerCase()) ?? 1 };
          case "stealthMetaAddressOf":
            return META;
          case "balanceOf":
            return this.credits.filter((c) => c.stealth === String(args[1]).toLowerCase() && c.block <= (blockNumber ?? this.head)).reduce((a, c) => a + c.raw, 0n);
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      getLogs: async (q: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock?: bigint; toBlock?: bigint | "latest"; blockHash?: Hash }) => {
        if (q.blockHash !== undefined) {
          if (this.unknownBlocks.has(q.blockHash)) throw new Error(`unknown block ${q.blockHash}`);
        } else if (q.toBlock !== "latest" && q.toBlock! > this.head) throw new Error(`header not found (block ${q.toBlock})`);
        const inRange = (l: Log) => (q.blockHash !== undefined ? l.blockHash === q.blockHash : l.blockNumber >= q.fromBlock! && (q.toBlock === "latest" || l.blockNumber <= q.toBlock!));
        return this.logs.filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && l.eventName === q.event.name && match(l, q.args) && inRange(l));
      },
    } as unknown as PublicClient;
  }
}

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let chain: FakeCrowd;
let ctx: Ctx;
const planKey = (user: Address) => `${ASSET.toLowerCase()}:0:${user.toLowerCase()}`;
const plan = async (user: Address) => (await getJob(ctx, "quiet-plan", planKey(user)))!;
const partRows = async (user: Address) => (await t.sql`select job_key, status from keeper_jobs where kind = 'quiet-part' and job_key like ${`${planKey(user)}:%`}`) as unknown as { status: string }[];

async function evLog(eventName: string, args: Record<string, string>, block: number, i: number) {
  await t.sql`insert into ev_logs (chain_id, block_number, block_hash, tx_hash, log_index, address, topic0, data_json)
    values (31337, ${block}, ${`0x${"b".repeat(64)}`}, ${keccak256(toHex(`${eventName}-${i}`))}, ${i}, ${CROWD.toLowerCase()}, null, ${JSON.stringify({ eventName, args })}::jsonb)`;
}
/** Another execution (of any book) happened: the next part of every plan is due. */
let execs = 0;
async function executed(bookId = "0") {
  await evLog("Executed", { asset: ASSET, bookId }, 50 + execs, 100 + execs);
  execs++;
}

/** One keeper pass of deliver-quiet; a thrown error is what runPass would record. */
async function pass(): Promise<{ res: JobResult; error?: unknown }> {
  try {
    return { res: await runDeliverQuiet(ctx) };
  } catch (error) {
    return { res: { job: "deliver-quiet", ok: false, actions: 0, notes: [] }, error };
  }
}

async function owedTo(user: Address): Promise<bigint> {
  const p = (await plan(user)).payload as Plan;
  const done = new Set(((await partRows(user)) as unknown as { job_key: string; status: string }[]).filter((x) => x.status === "done").map((x) => Number(x.job_key.split(":").pop())));
  return p.parts.reduce((a, part, i) => a + (done.has(i) ? 0n : BigInt(part.raw)), 0n);
}

/** The pool always covers every part still owed to a proven Quiet delivery. */
async function owed(): Promise<bigint> {
  const plans = (await t.sql`select job_key, payload from keeper_jobs where kind = 'quiet-plan' and status = 'delivered'`) as unknown as { job_key: string; payload: Plan }[];
  let sum = 0n;
  for (const p of plans) {
    const done = new Set(((await t.sql`select job_key from keeper_jobs where kind = 'quiet-part' and status = 'done' and job_key like ${`${p.job_key}:%`}`) as unknown as { job_key: string }[]).map((r) => Number(r.job_key.split(":").pop())));
    p.payload.parts.forEach((part, i) => (sum += done.has(i) ? 0n : BigInt(part.raw)));
  }
  return sum;
}

beforeAll(async () => {
  t = await keeperTestDb("quietproof");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from keeper_jobs" as never);
  await t.db.execute("delete from ev_logs" as never);
  execs = 0;
  chain = new FakeCrowd();
  ctx = {
    chainId: 31337,
    db: t.db,
    pub: chain.pub(),
    account: KEEPER,
    sender: new Sender(chain.io(), KEEPER, { sleep: async () => {}, pollMs: 1, waitMs: 3 }),
    dep: { crowd: CROWD, stealthClaims: CLAIMS, vault: VAULT, erc6538Registry: REGISTRY } as unknown as KeeperDeployment,
    lookahead: 2,
    splitParts: 2,
    log: () => {},
  } as unknown as Ctx;
  await evLog("Joined", { asset: ASSET, bookId: "0", user: VICTIM }, 40, 1);
  await evLog("Joined", { asset: ASSET, bookId: "0", user: USER }, 40, 2);
  await executed();
});

describe("E1: a plan is delivered only on proof of OUR Quiet deliver", () => {
  test("plan inserted -> deliver simulate fails -> user claims openly -> next pass: no deliverStealth for them, pool untouched", async () => {
    chain.simFail.set(USER.toLowerCase(), "QuietNotConfigured");
    let r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.notes.join(" ")).toContain("deliver reverts QuietNotConfigured");
    expect((await plan(USER)).status).toBe("planned");
    expect((await plan(VICTIM)).status).toBe("delivered"); // victim's allocation is in the pool, part 0 out
    const pooledBefore = chain.pooled;
    expect(pooledBefore).toBe(await owed());

    chain.claimOpen(USER);
    expect(chain.paidOpen.get(USER.toLowerCase())).toBe(400n);
    const stealthSends = chain.signed.length;
    r = await pass();
    expect(r.error).toBeUndefined();
    const row = await plan(USER);
    expect(row.status).toBe("skipped");
    expect((row.payload as { reason: string }).reason).toContain("claimed openly");
    expect(JSON.stringify((row.payload as Plan).parts)).not.toContain("stealth"); // nothing will ever go out; link scrubbed
    expect(await partRows(USER)).toHaveLength(0);
    expect(chain.signed.length).toBe(stealthSends); // no deliverStealth at all
    expect(chain.pooled).toBe(pooledBefore);

    // the victim's remaining part still goes out in full at the next execution
    await executed("1");
    r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("done");
    expect(chain.creditedTotal()).toBe(600n);
    expect(chain.pooled).toBe(0n);
    for (let i = 0; i < 3; i++) await pass();
    expect(chain.creditedTotal()).toBe(600n); // the user who claimed openly never got a second copy
  });

  test("plan inserted -> deliver TxUnconfirmed -> the user's claimOpen wins (ours reverts AlreadySettled) -> skipped", async () => {
    chain.autoMine = false;
    let r = await pass();
    expect(r.error).toBeInstanceOf(TxUnconfirmed); // the victim's deliver is first in order and stays pending
    // the pending tx belongs to the first candidate (VICTIM); race the claim for him
    const p = (await plan(VICTIM)).payload as Plan;
    expect(p.deliverTx?.hash).toBeDefined(); // stored before the broadcast
    chain.claimOpen(VICTIM);
    chain.mine(); // our deliver now mines and reverts AlreadySettled
    expect([...chain.receipts.values()].map((x) => x.status)).toEqual(["reverted"]);
    chain.autoMine = true;
    r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("skipped");
    expect(await partRows(VICTIM)).toHaveLength(0);
    // the other user is delivered and only their own allocation leaves the pool
    expect((await plan(USER)).status).toBe("delivered");
    await executed("1");
    await pass();
    await pass();
    expect(chain.creditedTotal()).toBe(400n);
    expect(chain.pooled).toBe(0n);
  });

  test("still pending when the user claims: Claimed is found pinned at the settled block -> skipped, pending deliver never credits", async () => {
    chain.autoMine = false;
    await pass(); // TxUnconfirmed for VICTIM
    chain.claimOpen(VICTIM); // our deliver is still in the pool
    chain.autoMine = true;
    const r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("skipped");
    while (chain.mine());
    expect(chain.settled(VICTIM)).toBe(true);
    for (let i = 0; i < 3; i++) await pass();
    expect(await partRows(VICTIM)).toHaveLength(0);
    expect(chain.pooled).toBe(await owed());
  });

  test("deliver landed -> receipt lost -> the Delivered log (after StealthClaims' Pooled, same tx) proves it -> delivered", async () => {
    chain.loseReceipts = true;
    let r = await pass();
    expect(r.error).toBeInstanceOf(TxUnconfirmed);
    expect(chain.settled(VICTIM)).toBe(true); // it mined; we never saw the receipt
    chain.loseReceipts = false;
    chain.receipts.clear(); // and the node never will
    r = await pass();
    expect(r.error).toBeUndefined();
    const row = await plan(VICTIM);
    expect(row.status).toBe("delivered");
    expect((row.payload as Plan).delivered).toMatchObject({ raw: "600", via: "log" });
    expect(chain.deliversSigned()).toBe(2); // victim once, then the other user; never a second deliver for the victim
    await executed("1");
    await pass();
    expect((await plan(VICTIM)).status).toBe("done");
    expect((await plan(USER)).status).toBe("done");
    expect(chain.creditedTotal()).toBe(1000n);
    expect(chain.pooled).toBe(0n);
  });

  test("keeper killed between signing and broadcasting the deliver: the stored bytes go out, one deliver, paid once", async () => {
    chain.killNextBroadcast = true;
    let r = await pass();
    expect(String(r.error)).toContain("process killed");
    const p = (await plan(VICTIM)).payload as Plan;
    expect(p.deliverTx?.nonce).toBe(0);
    expect(chain.settled(VICTIM)).toBe(false);
    r = await pass(); // not settled, nonce 0 still free: the same bytes are rebroadcast (and mine), nothing new signed
    expect(r.res.notes.join(" ")).toContain("still pending");
    expect(chain.deliversSigned()).toBe(2); // the victim's one deliver + the other user's
    r = await pass();
    expect((await plan(VICTIM)).status).toBe("delivered");
    expect(((await plan(VICTIM)).payload as Plan).delivered?.via).toBe("receipt");
    expect(((await plan(VICTIM)).payload as Plan).deliverTx?.raw).toBeNull();
    await executed("1");
    await pass();
    expect(chain.deliversSigned()).toBe(2);
    expect(chain.creditedTotal()).toBe(1000n);
    expect(chain.pooled).toBe(0n);
  });

  test("keeper killed after the plan insert and before anything was signed: the next pass sends one deliver", async () => {
    const io = chain.io();
    let killed = false;
    (ctx as { sender: Sender }).sender = new Sender(
      { ...io, estimateGas: async (a) => (killed ? io.estimateGas(a) : ((killed = true), Promise.reject(new Error("process killed after the insert")))) },
      KEEPER,
      { sleep: async () => {}, pollMs: 1, waitMs: 3 },
    );
    let r = await pass();
    expect(String(r.error)).toContain("process killed");
    expect((await plan(VICTIM)).status).toBe("planned");
    expect(((await plan(VICTIM)).payload as Plan).deliverTx).toBeUndefined();
    r = await pass();
    expect(r.error).toBeUndefined();
    await executed("1");
    await pass();
    expect(chain.deliversSigned()).toBe(2);
    expect(chain.creditedTotal()).toBe(1000n);
    expect(chain.pooled).toBe(0n);
  });

  test("settled by a deliver that pooled nothing into StealthClaims (Hidden): skipped, nothing released", async () => {
    chain.simFail.set(VICTIM.toLowerCase(), "NotQuiet");
    await pass(); // plan inserted for the victim, deliver refused; USER delivered
    chain.deliverHidden(VICTIM);
    const r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("skipped");
    expect(((await plan(VICTIM)).payload as { reason: string }).reason).toContain("pooled nothing");
    await executed("1");
    await pass();
    expect(await partRows(VICTIM)).toHaveLength(0);
    expect(chain.creditedTotal()).toBe(400n);
    expect(chain.pooled).toBe(0n);
  });

  test("Delivered found but the node asked for that block's Pooled log does not have the block: waits, never 'another route'", async () => {
    chain.loseReceipts = true;
    await pass(); // the victim's deliver mines, its receipt is never seen
    chain.loseReceipts = false;
    chain.receipts.clear();
    const d = chain.logs.find((l) => l.eventName === "Delivered")!;
    chain.unknownBlocks.add(d.blockHash);
    let r = await pass();
    expect(String(r.error)).toContain("unknown block");
    expect((await plan(VICTIM)).status).toBe("planned");
    chain.unknownBlocks.clear();
    r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("delivered");
  });

  test("settled, but no Delivered or Claimed log visible yet (lagging node): waits, neither delivered nor skipped", async () => {
    chain.simFail.set(USER.toLowerCase(), "QuietNotConfigured");
    await pass();
    chain.claimOpen(USER);
    chain.logs = chain.logs.filter((l) => l.eventName !== "Claimed"); // the log node has not got it
    const r = await pass();
    expect(r.res.notes.join(" ")).toContain("no Delivered or Claimed log");
    expect((await plan(USER)).status).toBe("planned");
    expect(await partRows(USER)).toHaveLength(0);
  });

  test("a row an older keeper promoted to delivered without proof: proven in the release phase; claimed openly -> skipped", async () => {
    chain.simFail.set(USER.toLowerCase(), "QuietNotConfigured");
    await pass();
    chain.claimOpen(USER);
    await setJob(ctx, "quiet-plan", planKey(USER), { status: "delivered" }); // what the old code did
    const before = chain.pooled;
    const r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(USER)).status).toBe("skipped");
    expect(await partRows(USER)).toHaveLength(0);
    expect(chain.pooled).toBe(before);
  });

  test("the proven raw must equal plan.allocation and the parts must sum to it, or nothing is released", async () => {
    chain.simFail.set(USER.toLowerCase(), "QuietNotConfigured");
    await pass();
    const p = (await plan(USER)).payload as Plan;
    await setJob(ctx, "quiet-plan", planKey(USER), { status: "planned", payload: { allocation: "399" } }); // a plan that disagrees with the chain
    chain.simFail.clear();
    let r = await pass();
    expect((await plan(USER)).status).toBe("delivered"); // our deliver landed (400 pooled) ...
    expect(r.res.notes.join(" ")).toContain("delivered raw 400 != planned allocation 399");
    expect(await partRows(USER)).toHaveLength(0); // ... but nothing goes out
    await setJob(ctx, "quiet-plan", planKey(USER), { status: "delivered", payload: { allocation: "400", parts: [{ ...p.parts[0]!, raw: "1" }, ...p.parts.slice(1)] } });
    r = await pass();
    expect(r.res.notes.join(" ")).toMatch(/parts sum \d+ != delivered raw 400/);
    expect(await partRows(USER)).toHaveLength(0);
  });
});

describe("confirmations: proofs are read at head - KEEPER_CONFIRMATIONS", () => {
  test("a deliver mined above the confirmed block is not proof yet: no part goes out until it has the confirmations", async () => {
    (ctx as { confirmations?: number }).confirmations = 2;
    let r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.notes.join(" ")).toContain("proven once confirmed");
    expect((await plan(VICTIM)).status).toBe("planned");
    expect((await plan(USER)).status).toBe("planned");
    expect(await partRows(VICTIM)).toHaveLength(0);
    expect(chain.pooled).toBe(1000n); // both delivers mined (blocks 101, 102), head 102, confirmed 100

    r = await pass(); // no new block: the stored deliver is still above the confirmed block; nothing new is signed
    expect(r.res.notes.join(" ")).toContain("above the confirmed block");
    expect(chain.deliversSigned()).toBe(2);
    expect(await partRows(VICTIM)).toHaveLength(0);

    chain.head += 2n; // two more blocks: both delivers confirmed
    r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("delivered");
    expect(((await plan(VICTIM)).payload as Plan).delivered).toMatchObject({ raw: "600", via: "receipt", atBlock: "102" });
    // part 0 of each went out but is above the confirmed block: still "sending", never sent twice
    expect((await partRows(VICTIM)).map((x) => x.status)).toEqual(["sending"]);
    expect(r.res.notes.join(" ")).toContain("done once confirmed");
    const signed = chain.signed.length;
    r = await pass();
    expect(chain.signed.length).toBe(signed);
    expect((await partRows(VICTIM)).map((x) => x.status)).toEqual(["sending"]);
    chain.head += 2n;
    r = await pass();
    expect((await partRows(VICTIM)).map((x) => x.status)).toEqual(["done"]);
    expect((await partRows(USER)).map((x) => x.status)).toEqual(["done"]);
    expect(chain.signed.length).toBe(signed);
    expect(chain.pooled).toBe(await owed());
  });

  test("last part: the proof is re-read first; our deliver reorged away -> last part held, plan back to the deliver phase, re-delivered once", async () => {
    let r = await pass(); // confirmations 0: both delivered, part 0 of each out
    expect(r.error).toBeUndefined();
    const victim = (await plan(VICTIM)).payload as Plan;
    const deliverTx = victim.delivered!.tx;
    const part0 = chain.logs.find((l) => l.eventName === "Credited" && String(l.args.stealth).toLowerCase() === victim.parts[0]!.stealth.toLowerCase())!;
    chain.reorgOut([deliverTx, part0.transactionHash]); // deeper than any confirmation count
    expect(chain.settled(VICTIM)).toBe(false);
    expect(chain.pooled).toBe(await owedTo(USER)); // only the other user's allocation is left in the pool

    await executed("1"); // both last parts are due
    r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.notes.join(" ")).toContain("no longer on the chain");
    const row = await plan(VICTIM);
    expect(row.status).toBe("planned");
    expect((row.payload as Plan).delivered).toBeNull();
    expect((await partRows(VICTIM)).map((x) => x.status)).toEqual(["done"]); // part 1 was never sent
    expect((await plan(USER)).status).toBe("done"); // the other user's proof still holds: paid in full from their own allocation
    expect(chain.credits.filter((c) => c.stealth !== victim.parts[1]!.stealth.toLowerCase()).reduce((a, c) => a + c.raw, 0n)).toBe(400n);
    expect(chain.pooled).toBe(0n);

    r = await pass(); // the deliver phase sends a new deliver (the old nonce is used), proves it, then releases the last part
    expect(r.error).toBeUndefined();
    expect(chain.deliversSigned()).toBe(3);
    expect((await plan(VICTIM)).status).toBe("done");
    expect(chain.pooled).toBeGreaterThanOrEqual(0n);
    for (let i = 0; i < 3; i++) await pass();
    expect(chain.deliversSigned()).toBe(3);
  });

  test("last part: the same proof at the newer confirmed block -> released, proof moved to that block", async () => {
    await pass();
    await executed("1");
    chain.head += 5n;
    const r = await pass();
    expect(r.error).toBeUndefined();
    expect((await plan(VICTIM)).status).toBe("done");
    expect(chain.creditedTotal()).toBe(1000n);
  });

  test("last part: the user's settlement turned into an open claim on the new branch -> held for a manual check", async () => {
    await pass();
    const victim = (await plan(VICTIM)).payload as Plan;
    chain.reorgOut([victim.delivered!.tx]);
    chain.pooled += 600n; // keep the books simple: only the proof changes
    chain.claimOpen(VICTIM);
    await executed("1");
    const r = await pass();
    expect(r.res.notes.join(" ")).toContain("held for a manual check");
    expect((await plan(VICTIM)).status).toBe("delivered");
    expect((await partRows(VICTIM)).map((x) => x.status)).toEqual(["done"]);
  });
});
