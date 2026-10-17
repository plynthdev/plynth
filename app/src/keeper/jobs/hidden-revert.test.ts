// Review v2, V2-L14 (KEEP-1): a deliver that reverts on-chain (the user's own claimOpen or cancel lands between the
// keeper's simulation and its send) threw TxReverted out of deliver-hidden, so every later Hidden user waited a pass and
// insertPending did not run. quiet.ts already caught it. Harness from hidden-malformed.test.ts: real Postgres rows,
// a fake CrowdBuy / SavingsVault / ShieldedPool and a recording sender.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { deriveVaultKeys, initVault, registration } from "@plynth/sdk/vault";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { Ctx, KeeperDeployment } from "@/keeper/context";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runDeliverHidden } from "@/keeper/jobs/hidden";
import { TxReverted } from "@/keeper/sender";

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
let raceRevert = true;

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
        if (fn === "deliver" && String(args[2]).toLowerCase() === ATTACKER.toLowerCase() && raceRevert) throw new TxReverted(`0x${"de".repeat(32)}`, "deliver-hidden");
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


describe("V2-L14: a reverted Hidden deliver does not stop the job", () => {
  test("attacker (valid keys, sorted first) -> TxReverted -> noted; victim delivered and insertPending still runs", async () => {
    keys.set(ATTACKER.toLowerCase(), registration(deriveVaultKeys(`0x${"55".repeat(65)}` as Hex)));
    const r = await runDeliverHidden(ctx);
    const delivered = sent.filter((s) => s.fn === "deliver").map((s) => s.user);
    expect(delivered).toEqual([VICTIM.toLowerCase()]);
    expect(sent.some((s) => s.fn === "insertPending")).toBe(true);
    expect(r.notes.some((n) => n.includes(ATTACKER) && n.includes("reverted"))).toBe(true);
    // the attacker is not marked delivered: the next pass re-reads how the allocation was settled
    const rows = (await t.sql`select user_address, status from keeper_hidden_deliveries order by user_address`) as unknown as { user_address: string; status: string }[];
    expect(rows).toEqual([{ user_address: VICTIM.toLowerCase(), status: "delivered" }]);
  });

  test("an insertPending that reverts (someone else inserted first) is noted, not thrown", async () => {
    keys.set(ATTACKER.toLowerCase(), registration(deriveVaultKeys(`0x${"55".repeat(65)}` as Hex)));
    raceRevert = false;
    const orig = ctx.sender.sendCall;
    (ctx.sender as any).sendCall = async (to: Address, abi: unknown, fn: string, args: readonly unknown[], label: string) => {
      if (fn === "insertPending") throw new TxReverted(`0x${"ef".repeat(32)}`, label);
      return (orig as any)(to, abi, fn, args, label);
    };
    const r = await runDeliverHidden(ctx);
    raceRevert = true;
    expect(r.ok).toBe(true);
    expect(r.notes.some((n) => n.includes("insertPending") && n.includes("reverted"))).toBe(true);
  });
});
