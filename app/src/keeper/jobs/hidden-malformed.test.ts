// Audit M-6 (Hidden): SavingsVault.setHiddenKeys accepts any two words. An attacker who sorts first (0x00…) registers
// a low-order x25519 viewing key; before the fix encryptNote threw on them, the deliver-hidden job failed every pass,
// no honest Hidden saver was ever delivered and insertPending never ran. Now that user is skipped (recorded) and the
// pass goes on. Real Postgres rows; a fake CrowdBuy / SavingsVault / ShieldedPool and a recording sender.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { deriveVaultKeys, initVault, registration } from "@plynth/sdk/vault";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { Ctx, KeeperDeployment } from "@/keeper/context";
import { getJob } from "@/keeper/jobstore";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runDeliverHidden } from "./hidden";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const CROWD = A(0xc0);
const VAULT = A(0xc2);
const POOL = A(0xc4);
const ASSET = A(0x7e);
const ATTACKER = A(0x01);
const VICTIM = A(0x22);
// Order-8 point of Curve25519 (libsodium's blocklist): every clamped scalar maps it to the zero shared secret.
const LOW_ORDER = `0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800` as Hex; // not-a-key

let t: Awaited<ReturnType<typeof keeperTestDb>>;
let ctx: Ctx;
let sent: { fn: string; user?: string }[];
let keys: Map<string, { ownerPk: Hex; viewingPub: Hex }>;
let ready: bigint;

async function evLog(eventName: string, args: Record<string, string>, i: number) {
  await t.sql`insert into ev_logs (chain_id, block_number, block_hash, tx_hash, log_index, address, topic0, data_json)
    values (31337, ${40 + i}, ${`0x${"b".repeat(64)}`}, ${keccak256(toHex(`${eventName}-${i}`))}, ${i}, ${CROWD.toLowerCase()}, null, ${JSON.stringify({ eventName, args })}::jsonb)`;
}

beforeAll(async () => {
  await initVault();
  t = await keeperTestDb("hiddenbad");
});
afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute("delete from keeper_jobs" as never);
  await t.db.execute("delete from keeper_hidden_deliveries" as never);
  await t.db.execute("delete from ev_logs" as never);
  sent = [];
  ready = 1n; // a pending deposit from earlier is ready to insert
  keys = new Map([
    [ATTACKER.toLowerCase(), { ownerPk: `0x${"00".repeat(31)}07` as Hex, viewingPub: LOW_ORDER }],
    [VICTIM.toLowerCase(), registration(deriveVaultKeys(`0x${"77".repeat(65)}` as Hex))],
  ]);
  const settled = new Set<string>();
  ctx = {
    chainId: 31337,
    db: t.db,
    account: A(0xaa),
    dep: { crowd: CROWD, vault: VAULT, shieldedPool: POOL } as unknown as KeeperDeployment,
    log: () => {},
    pub: {
      readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        const who = String(args?.[functionName === "settingsOf" || functionName === "hiddenKeysOf" ? 0 : 2]).toLowerCase();
        switch (functionName) {
          case "settled":
            return settled.has(who);
          case "orderOf":
            return 1n;
          case "settingsOf":
            return { mode: 2 };
          case "hiddenKeysOf":
            return keys.get(who)!;
          case "allocationOf":
            return 500n;
          case "readyCount":
            return ready;
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      simulateContract: async () => ({ result: undefined }),
    },
    sender: {
      address: A(0xaa),
      sendCall: async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[]) => {
        if (fn === "deliver") settled.add(String(args[2]).toLowerCase());
        if (fn === "insertPending") ready = 0n;
        sent.push({ fn, ...(fn === "deliver" ? { user: String(args[2]).toLowerCase() } : {}) });
        return { transactionHash: keccak256(toHex(`tx-${sent.length}`)), blockNumber: 1n, status: "success", logs: [] };
      },
    },
  } as unknown as Ctx;
  await evLog("Joined", { asset: ASSET, bookId: "0", user: ATTACKER }, 1);
  await evLog("Joined", { asset: ASSET, bookId: "0", user: VICTIM }, 2);
  await evLog("Executed", { asset: ASSET, bookId: "0" }, 3);
});

describe("M-6: a low-order Hidden key skips that user only", () => {
  test("attacker sorts first with a low-order viewing key: the victim is delivered and insertPending still runs", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runDeliverHidden(ctx);
      expect(r.ok).toBe(true);
      expect(r.notes.join(" ")).toContain(`${ATTACKER}: skipped, Hidden but viewingPub is a low-order x25519 point`);
    }
    expect(sent.filter((s) => s.fn === "deliver").map((s) => s.user)).toEqual([VICTIM.toLowerCase()]);
    expect(sent.some((s) => s.fn === "insertPending")).toBe(true);
    const [row] = (await t.sql`select status from keeper_hidden_deliveries where user_address = ${VICTIM.toLowerCase()}`) as unknown as { status: string }[];
    expect(row!.status).toBe("delivered");
    const skip = (await getJob(ctx, "hidden-skip", `${ASSET.toLowerCase()}:0:${ATTACKER.toLowerCase()}`))!;
    expect(skip.status).toBe("skipped");
    // not recorded as a delivery: once the attacker re-registers valid keys they are served
    expect(await t.sql`select 1 from keeper_hidden_deliveries where user_address = ${ATTACKER.toLowerCase()}`).toHaveLength(0);
  });

  test("an ownerPk outside the field is refused before planning too", async () => {
    keys.set(ATTACKER.toLowerCase(), { ownerPk: `0x${"ff".repeat(32)}` as Hex, viewingPub: keys.get(VICTIM.toLowerCase())!.viewingPub });
    const r = await runDeliverHidden(ctx);
    expect(r.notes.join(" ")).toContain("ownerPk is not a field element");
    expect(sent.filter((s) => s.fn === "deliver").map((s) => s.user)).toEqual([VICTIM.toLowerCase()]);
  });

  test("a user who re-registers valid keys is delivered on a later pass", async () => {
    await runDeliverHidden(ctx);
    keys.set(ATTACKER.toLowerCase(), registration(deriveVaultKeys(`0x${"55".repeat(65)}` as Hex)));
    await runDeliverHidden(ctx);
    expect(sent.filter((s) => s.fn === "deliver").map((s) => s.user)).toEqual([VICTIM.toLowerCase(), ATTACKER.toLowerCase()]);
  });
});
