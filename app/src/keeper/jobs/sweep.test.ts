// Job sweep: one user whose read throws never stops the sweep for everyone (per-user isolation), over a real
// Postgres ev_logs table and a fake chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encodeEventTopics, getAddress, keccak256, toHex, type Address } from "viem";
import { crowdAbi } from "@/abi/keeper";
import type { Ctx, KeeperDeployment } from "@/keeper/context";
import { keeperTestDb } from "@/testing/keeper-helpers";
import { runSweep } from "./sweep";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const VAULT = A(0xc2), CROWD = A(0xc0), KEEPER = A(0xaa);
const U1 = A(0x11), U2 = A(0x22), U3 = A(0x33);

let t: Awaited<ReturnType<typeof keeperTestDb>>;
beforeAll(async () => {
  t = await keeperTestDb("sweepiso");
  let i = 0;
  for (const u of [U1, U2, U3])
    await t.sql`insert into ev_logs (chain_id, block_number, block_hash, tx_hash, log_index, address, topic0, data_json)
      values (31337, 10, ${`0x${"b".repeat(64)}`}, ${keccak256(toHex(`set-${u}`))}, ${i++}, ${VAULT.toLowerCase()}, null, ${JSON.stringify({ eventName: "SettingsSet", args: { user: u } })}::jsonb)`;
});
afterAll(async () => {
  await t?.drop();
});

describe("sweep isolates each user", () => {
  test("a throwing read for one user is a note; the others are joined in one joinBatch", async () => {
    const batches: Address[][] = [];
    const joinedLog = (user: Address) => ({
      address: CROWD,
      topics: encodeEventTopics({ abi: crowdAbi, eventName: "Joined", args: { asset: A(0x7e), bookId: 0n, user } }),
      data: toHex(1n, { size: 32 }),
      blockNumber: 1n, transactionHash: `0x${"1".repeat(64)}`, logIndex: 0, blockHash: `0x${"2".repeat(64)}`, transactionIndex: 0, removed: false,
    });
    const ctx = {
      chainId: 31337,
      db: t.db,
      account: KEEPER,
      dep: { vault: VAULT, crowd: CROWD } as unknown as KeeperDeployment,
      pub: {
        readContract: async ({ args }: { args: readonly unknown[] }) => {
          if (args[0] === U2) throw new Error("rpc: connection reset\nstack");
          return [0n, 5n];
        },
        simulateContract: async () => ({ result: undefined }),
        estimateContractGas: async () => 150_000n,
      },
      sender: {
        sendCall: async (_to: Address, _abi: unknown, _fn: string, args: readonly unknown[]) => {
          const users = args[0] as Address[];
          batches.push(users);
          return { transactionHash: `0x${"3".repeat(64)}`, logs: users.map(joinedLog) };
        },
      },
      log: () => {},
    } as unknown as Ctx;
    const r = await runSweep(ctx);
    expect(batches).toEqual([[U1, U3]]);
    expect(r.actions).toBe(1);
    expect(r.notes.join("|")).toContain(`${U2}: skipped this pass (rpc: connection reset)`);
  });
});
