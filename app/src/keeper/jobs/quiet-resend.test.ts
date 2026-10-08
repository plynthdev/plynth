// deliver-quiet never sends a second deliverStealth for a part while an earlier transaction for it may still
// mine (StealthClaims.credit draws from the pool every Quiet user shares; nothing on-chain stops a double
// credit). Real Postgres job rows + the real Sender over a fake chain that can hold a transaction pending, lose
// it, let another transaction take its nonce, lag behind on reads, or kill the process between signing and
// broadcasting.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, hexToString, keccak256, parseAbiItem, toHex, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { crowdAbi } from "@/abi/keeper";
import type { Ctx, JobResult, KeeperDeployment } from "@/keeper/context";
import { getJob, setJob } from "@/keeper/jobstore";
import { Sender, TxUnconfirmed, type SenderIO } from "@/keeper/sender";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { releasePhase, runDeliverQuiet, type Plan } from "./quiet";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const KEEPER = A(0xaa);
const CROWD = A(0xc0);
const CLAIMS = A(0xc1);
const ASSET = A(0x7e);
const STEALTH = A(0x5e);
const RAW = 1_000n;
const USER = A(0x11);
const DELIVER_TX = `0x${"de".repeat(32)}` as Hash;

/** Our Quiet deliver's receipt logs at block 99: StealthClaims Pooled(asset, raw) right before CrowdBuy Delivered. */
function deliverLogs() {
  const log = (address: Address, sig: string, args: Record<string, unknown>, data: Hex, logIndex: number) => {
    const event = parseAbiItem(sig) as any;
    return { address, topics: encodeEventTopics({ abi: [event], eventName: event.name, args } as any), data, logIndex, transactionHash: DELIVER_TX, blockNumber: 99n, blockHash: keccak256(toHex("block-99")) };
  };
  const raw = encodeAbiParameters([{ type: "uint256" }], [RAW]);
  return [
    log(CLAIMS, "event Pooled(address indexed token, uint256 raw)", { token: ASSET }, raw, 0),
    log(CROWD, "event Delivered(address indexed asset, uint256 indexed bookId, address indexed user, uint256 raw)", { asset: ASSET, bookId: 0n, user: USER }, raw, 1),
  ];
}

/** One keeper key's view of a chain. Everything a node can get wrong is a switch. */
class FakeChain {
  head = 100n;
  nonce = 0; // the keeper's confirmed (latest) nonce
  pool = new Map<number, { raw: Hex; hash: Hash; data: Hex }>();
  receipts = new Map<Hash, { status: "success" | "reverted"; blockNumber: bigint; logs?: unknown[] }>([[DELIVER_TX, { status: "success", blockNumber: 99n, logs: deliverLogs() }]]);
  credits: { stealth: Address; raw: bigint; block: bigint }[] = [];
  signed = new Set<Hash>();
  fee = 30n;
  autoMine = false;
  revertNext = false;
  /** Reads (balance, logs, receipts) come from a node whose head is lagHead: later effects are invisible. */
  lagHead: bigint | undefined;
  /** The next broadcast dies with the process (nothing reaches a node). */
  killNextBroadcast = false;

  visible(block: bigint) {
    return this.lagHead === undefined || block <= this.lagHead;
  }

  mine() {
    const tx = this.pool.get(this.nonce);
    if (!tx) return false;
    this.pool.delete(this.nonce);
    this.head++;
    this.nonce++;
    if (this.revertNext) {
      this.revertNext = false;
      this.receipts.set(tx.hash, { status: "reverted", blockNumber: this.head });
      return true;
    }
    const { args } = decodeFunctionData({ abi: crowdAbi, data: tx.data }) as { args: readonly unknown[] };
    this.credits.push({ stealth: (args[1] as Address).toLowerCase() as Address, raw: args[2] as bigint, block: this.head });
    this.receipts.set(tx.hash, { status: "success", blockNumber: this.head });
    return true;
  }

  /** Another keeper transaction is mined at our pending nonce; ours is dropped and can never mine. */
  takeNonce() {
    this.pool.delete(this.nonce);
    this.nonce++;
    this.head++;
  }

  creditedTo(stealth: Address) {
    return this.credits.filter((c) => c.stealth === stealth.toLowerCase()).length;
  }

  io(): SenderIO {
    return {
      estimateGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: this.fee++, maxPriorityFeePerGas: 2n }), // fees drift between signs
      getTransactionCount: async ({ blockTag }) => (blockTag === "pending" ? this.nonce + this.pool.size : this.nonce),
      signTransaction: async (tx) => {
        const raw = toHex(JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        this.signed.add(keccak256(raw));
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
        if (!r || !this.visible(r.blockNumber)) return null;
        return { transactionHash: hash, status: r.status, blockNumber: r.blockNumber, logs: r.logs ?? [] } as unknown as TransactionReceipt;
      },
    };
  }

  pub(): PublicClient {
    const pinned = (b: bigint | undefined) => {
      if (b !== undefined && this.lagHead !== undefined && b > this.lagHead) throw new Error(`header not found (block ${b})`);
    };
    return {
      getBlockNumber: async () => this.head,
      getTransactionCount: async () => this.nonce, // served by an up-to-date node
      simulateContract: async () => ({ result: undefined }),
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
        if (functionName !== "balanceOf") throw new Error(`unexpected read ${functionName}`);
        pinned(blockNumber);
        return this.credits.filter((c) => c.stealth === String(args[1]).toLowerCase() && this.visible(c.block) && (blockNumber === undefined || c.block <= blockNumber)).reduce((a, c) => a + c.raw, 0n);
      },
      getLogs: async ({ args, fromBlock, toBlock }: { args: { stealth: Address }; fromBlock: bigint; toBlock: bigint | "latest" }) => {
        pinned(toBlock === "latest" ? undefined : toBlock);
        return this.credits.filter((c) => c.stealth === args.stealth.toLowerCase() && c.block >= fromBlock && this.visible(c.block) && (toBlock === "latest" || c.block <= toBlock));
      },
    } as unknown as PublicClient;
  }
}

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let chain: FakeChain;
let ctx: Ctx;
let clock = 1_000_000;
const PLAN_KEY = `${ASSET.toLowerCase()}:0:${USER.toLowerCase()}`;
const PART_KEY = `${PLAN_KEY}:0`;

const plan: Plan = {
  asset: ASSET,
  bookId: "0",
  user: USER,
  allocation: RAW.toString(),
  parts: [{ stealth: STEALTH, ephemeralPublicKey: `0x02${"ab".repeat(32)}` as Hex, viewTag: "0x7a" as Hex, raw: RAW.toString(), releaseAt: 0 }],
  // our deliver, proven (quiet-proof.test.ts); its receipt is still there when the last part's proof is re-read
  deliverTx: { hash: DELIVER_TX, nonce: 0, raw: null },
  delivered: { raw: RAW.toString(), tx: DELIVER_TX, via: "receipt", atBlock: "99" },
};

const result = (): JobResult => ({ job: "deliver-quiet", ok: true, actions: 0, notes: [] });
const opts = { now: () => clock, takenGraceMs: 60_000 };
/** One keeper pass of the release phase; a thrown error is what runPass would record. */
async function pass(): Promise<{ res: JobResult; error?: unknown }> {
  const res = result();
  try {
    await releasePhase(ctx, res, 0, opts);
    return { res };
  } catch (error) {
    return { res, error };
  }
}
const part = async () => (await getJob(ctx, "quiet-part", PART_KEY))!;

beforeAll(async () => {
  t = await keeperTestDb("quietresend");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from keeper_jobs" as never);
  chain = new FakeChain();
  ctx = {
    chainId: 31337,
    db: t.db,
    pub: chain.pub(),
    account: KEEPER,
    sender: new Sender(chain.io(), KEEPER, { sleep: async () => {}, pollMs: 1, waitMs: 3 }),
    dep: { crowd: CROWD, stealthClaims: CLAIMS } as unknown as KeeperDeployment,
    lookahead: 2,
    log: () => {},
  } as unknown as Ctx;
  await setJob(ctx, "quiet-plan", PLAN_KEY, { status: "delivered", payload: plan as unknown as Record<string, unknown> });
});

describe("deliver-quiet: one transaction per part, whatever happens to it", () => {
  test("D4: TxUnconfirmed, then still pending on the next passes: nothing new is signed; once it mines, done, credited once", async () => {
    const first = await runDeliverQuiet(ctx, opts).catch((e) => e);
    expect(first).toBeInstanceOf(TxUnconfirmed);
    const row = await part();
    expect(row.status).toBe("sending");
    expect(row.payload).toMatchObject({ stage: "signed", nonce: 0 });
    expect(chain.signed.size).toBe(1);

    for (let i = 0; i < 3; i++) {
      const { res, error } = await pass();
      expect(error).toBeUndefined();
      expect(res.actions).toBe(0);
      expect(res.notes.join(" ")).toContain("still pending");
    }
    expect(chain.signed.size).toBe(1); // no second transaction while the first may mine

    chain.mine();
    const { res } = await pass();
    expect(res.actions).toBe(0);
    expect((await part()).status).toBe("done");
    expect((await part()).payload).toMatchObject({ raw: null });
    expect(chain.creditedTo(STEALTH)).toBe(1);
    expect((await getJob(ctx, "quiet-plan", PLAN_KEY))!.status).toBe("done");
  });

  test("D4: a node that dropped it gets the same bytes again (same nonce), never a new transaction", async () => {
    await pass(); // TxUnconfirmed
    const { raw } = (await part()).payload as { raw: Hex };
    chain.pool.clear(); // the node forgot it
    await pass();
    expect([...chain.pool.values()].map((x) => x.raw)).toEqual([raw]);
    expect(chain.signed.size).toBe(1);
    chain.mine();
    await pass();
    expect((await part()).status).toBe("done");
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: mined but the read node lags (no balance, log or receipt yet): no resend; the pinned re-check waits for a node with the block", async () => {
    await pass(); // TxUnconfirmed
    chain.lagHead = chain.head; // reads come from a node that has not seen the mining block
    chain.mine(); // ours mines; the nonce node is up to date
    let r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.notes.join(" ")).toContain("re-checking later");
    expect(chain.signed.size).toBe(1);
    clock += 30_000;
    r = await pass(); // inside the grace period
    expect(r.res.notes.join(" ")).toContain("grace");
    clock += 60_000;
    r = await pass(); // past the grace: the pinned read refuses to answer from the past
    expect(String(r.error)).toContain("header not found");
    expect(chain.signed.size).toBe(1);
    chain.lagHead = undefined; // the node catches up
    r = await pass();
    expect(r.error).toBeUndefined();
    expect((await part()).status).toBe("done");
    expect(chain.signed.size).toBe(1);
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: another transaction took the nonce (ours can never mine): resent only after the grace period, credited once", async () => {
    await pass(); // TxUnconfirmed
    chain.takeNonce();
    let r = await pass();
    expect(r.res.notes.join(" ")).toContain("re-checking later");
    clock += 10_000;
    r = await pass();
    expect(r.res.notes.join(" ")).toContain("grace");
    expect(chain.signed.size).toBe(1);
    clock += 60_000;
    chain.autoMine = true;
    r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.actions).toBe(1);
    expect(chain.signed.size).toBe(2);
    expect((await part()).status).toBe("done");
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: the process dies between signing and broadcasting: the next pass broadcasts the stored bytes, nothing new", async () => {
    chain.killNextBroadcast = true;
    const r = await pass();
    expect(String(r.error)).toContain("process killed");
    expect((await part()).payload).toMatchObject({ stage: "signed", nonce: 0 });
    expect(chain.pool.size).toBe(0);
    chain.autoMine = true;
    await pass(); // rebroadcast of the same bytes, which mines
    await pass();
    expect((await part()).status).toBe("done");
    expect(chain.signed.size).toBe(1);
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: marked sending but never signed (died before signing): sent normally", async () => {
    await setJob(ctx, "quiet-part", PART_KEY, { status: "sending", payload: { fromBlock: "100", stage: "signing" } });
    chain.autoMine = true;
    const { res } = await pass();
    expect(res.actions).toBe(1);
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: its receipt reverted: nothing was credited, so it is sent again", async () => {
    chain.autoMine = true;
    chain.revertNext = true;
    const first = await pass();
    expect(String(first.error)).toContain("reverted");
    const { res } = await pass();
    expect(res.actions).toBe(1);
    expect(chain.signed.size).toBe(2);
    expect(chain.creditedTo(STEALTH)).toBe(1);
  });

  test("D4: a sending row from an older keeper (no recorded transaction) is held, never resent blind", async () => {
    await setJob(ctx, "quiet-part", PART_KEY, { status: "sending", payload: { fromBlock: "100" } });
    chain.autoMine = true;
    const { res } = await pass();
    expect(res.actions).toBe(0);
    expect(res.notes.join(" ")).toContain("by hand");
    expect(chain.signed.size).toBe(0);
  });

  test("a node refusing the kept-alive bytes (fee under the base fee) does not stop other parts going out", async () => {
    await pass(); // TxUnconfirmed: part 0 pending at nonce 0
    const io = chain.io();
    const send = io.sendRawTransaction;
    let refused = 0;
    (ctx as { sender: Sender }).sender = new Sender(
      { ...io, sendRawTransaction: async (a) => (a.serializedTransaction === ((await part()).payload as { raw: Hex }).raw ? (refused++, Promise.reject(new Error("max fee per gas less than block base fee"))) : send(a)) },
      KEEPER,
      { sleep: async () => {}, pollMs: 1, waitMs: 3 },
    );
    const { error, res } = await pass();
    expect(error).toBeUndefined();
    expect(refused).toBe(1);
    expect(res.notes.join(" ")).toContain("still pending");
  });
});
