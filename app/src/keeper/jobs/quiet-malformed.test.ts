// Audit M-6 (Quiet): one saver's malformed ERC-6538 meta-address must not stop Quiet delivery for everyone. The
// registry stores any 66 bytes, so an attacker registers a point that is not on secp256k1 under an address that
// sorts first (0x00…). Before the fix computeStealthAddress threw on that user, nothing caught it, the whole
// deliver-quiet job failed every pass, and the release phase (already-pooled parts) never ran.
// Real Postgres job rows + the real Sender over the fake CrowdBuy / StealthClaims.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseMetaAddress } from "@plynth/sdk/stealth";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { Ctx, JobResult, KeeperDeployment } from "@/keeper/context";
import { getJob } from "@/keeper/jobstore";
import { Sender } from "@/keeper/sender";
import { A, ASSET, CLAIMS, CROWD, FakeCrowd, KEEPER, META, REGISTRY, VAULT, VICTIM } from "@/testing/fake-crowd";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { quietMetaProblem, runDeliverQuiet } from "./quiet";

const ATTACKER = A(0x01); // 0x0000…01 sorts before every honest saver

/** 33-byte compressed "point" whose x has no y on secp256k1. */
function offCurve(): Hex {
  for (let x = 1; ; x++) {
    const p = `0x02${x.toString(16).padStart(64, "0")}` as Hex;
    try {
      parseMetaAddress(`${p}${p.slice(2)}`);
    } catch {
      return p;
    }
  }
}
const BAD_META = `${offCurve()}${META.slice(68)}` as Hex; // off-curve spending key, valid viewing key

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let chain: FakeCrowd;
let ctx: Ctx;
const planKey = (user: Address) => `${ASSET.toLowerCase()}:0:${user.toLowerCase()}`;

async function evLog(eventName: string, args: Record<string, string>, block: number, i: number) {
  await t.sql`insert into ev_logs (chain_id, block_number, block_hash, tx_hash, log_index, address, topic0, data_json)
    values (31337, ${block}, ${`0x${"b".repeat(64)}`}, ${keccak256(toHex(`${eventName}-${i}`))}, ${i}, ${CROWD.toLowerCase()}, null, ${JSON.stringify({ eventName, args })}::jsonb)`;
}

async function pass(): Promise<{ res: JobResult; error?: unknown }> {
  try {
    return { res: await runDeliverQuiet(ctx) };
  } catch (error) {
    return { res: { job: "deliver-quiet", ok: false, actions: 0, notes: [] }, error };
  }
}

beforeAll(async () => {
  t = await keeperTestDb("quietbad");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from keeper_jobs" as never);
  await t.db.execute("delete from ev_logs" as never);
  chain = new FakeCrowd();
  chain.alloc.set(ATTACKER.toLowerCase(), 1n);
  chain.meta.set(ATTACKER.toLowerCase(), BAD_META);
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
  await evLog("Joined", { asset: ASSET, bookId: "0", user: ATTACKER }, 40, 1);
  await evLog("Joined", { asset: ASSET, bookId: "0", user: VICTIM }, 40, 2);
  await evLog("Executed", { asset: ASSET, bookId: "0" }, 50, 100);
});

describe("M-6: a malformed meta-address skips that user only", () => {
  test("validation: off-curve, wrong length and empty are refused before planning; a real one passes", () => {
    expect(quietMetaProblem(META)).toBeNull();
    expect(quietMetaProblem(BAD_META)).toMatch(/not a valid/);
    expect(quietMetaProblem("0x")).toMatch(/no ERC-6538/);
    expect(quietMetaProblem(`0x${"02".repeat(65)}`)).toMatch(/66 bytes/);
  });

  test("attacker sorts first with an off-curve key: three passes in a row still deliver and release for the victim", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await pass();
      expect(r.error).toBeUndefined();
      expect(r.res.ok).toBe(true);
      expect(r.res.notes.join(" ")).toContain(`${ATTACKER}: skipped`);
      if (i === 0) await evLog("Executed", { asset: ASSET, bookId: "1" }, 51, 101); // the victim's second part comes due
    }
    // the honest saver was delivered and every part released from the pool
    expect((await getJob(ctx, "quiet-plan", planKey(VICTIM)))!.status).toBe("done");
    expect(chain.creditedTotal()).toBe(600n);
    // the attacker has no plan (nothing was ever sent for them) and a recorded skip with its reason
    expect(await getJob(ctx, "quiet-plan", planKey(ATTACKER))).toBeUndefined();
    const skip = (await getJob(ctx, "quiet-skip", planKey(ATTACKER)))!;
    expect(skip.status).toBe("skipped");
    expect(String((skip.payload as { reason: string }).reason)).toMatch(/not a valid/);
    expect(chain.deliversSigned()).toBe(1); // only the victim's deliver
  });

  test("an unexpected read error on one user is recorded as a skip, and the others still go out", async () => {
    chain.meta.delete(ATTACKER.toLowerCase());
    const pub = chain.pub();
    ctx.pub = {
      ...pub,
      readContract: async (q: { functionName: string; args: readonly unknown[] }) => {
        if (q.functionName === "settingsOf" && String(q.args[0]).toLowerCase() === ATTACKER.toLowerCase()) throw new Error("boom");
        return (pub.readContract as (x: unknown) => Promise<unknown>)(q);
      },
    } as unknown as Ctx["pub"];
    const r = await pass();
    expect(r.error).toBeUndefined();
    expect(r.res.notes.join(" ")).toContain(`${ATTACKER}: skipped this pass (boom)`);
    expect((await getJob(ctx, "quiet-plan", planKey(VICTIM)))!.status).toBe("delivered");
    expect(chain.creditedTotal()).toBeGreaterThan(0n);
  });

  test("a user who fixes their meta-address is delivered on a later pass (the skip is not permanent)", async () => {
    let r = await pass();
    expect(r.error).toBeUndefined();
    chain.meta.delete(ATTACKER.toLowerCase());
    r = await pass();
    expect(r.error).toBeUndefined();
    expect(["delivered", "done"]).toContain((await getJob(ctx, "quiet-plan", planKey(ATTACKER)))!.status);
  });
});
