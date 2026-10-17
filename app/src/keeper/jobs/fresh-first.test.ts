// Review v5, R5-SVC-1 (PoC review5x/keeper-fresh-first.test.ts, now asserting the safe side): the fair order put every
// never-served wallet ahead of every returning user whatever the age of their spends, so a supply of fresh linked
// wallets (about 87 per pass under the 5M-gas budget) kept returning users waiting. longestWaitingFirst orders by
// max(oldest pending item, last accrue): fresh wallets queue behind older pending work.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { longestWaitingFirst } from "@/keeper/jobs/roundups";

const T = (min: number) => Date.UTC(2026, 9, 17, 12, min);

test("87 never-served sybil wallets with newer spends cannot sort ahead of 50 returning users with older ones", async () => {
  const honest = Array.from({ length: 50 }, (_, i) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}`);
  const sybils = Array.from({ length: 87 }, (_, i) => `0x${(0xb000 + i).toString(16).padStart(40, "0")}`);
  const served = honest.map((u, i) => ({ u, last: new Date(Date.UTC(2026, 9, 1, 0, i)) })); // served last month
  const pending = new Map<string, number>([...honest.map((u) => [u, T(0)] as const), ...sybils.map((u) => [u, T(5)] as const)]);
  const ctx = { chainId: 4663, db: { execute: async () => served } } as never;
  const order = await longestWaitingFirst(ctx, sql`keeper_roundups`, [...honest, ...sybils], pending);
  expect(order.slice(0, 50).sort()).toEqual([...honest].sort()); // every returning user is reached in the first 87
});

test("a user just served goes behind everyone already waiting; a fresh wallet waits only from its own spend", async () => {
  const [a, b, c] = ["0xa", "0xb", "0xc"];
  const ctx = { chainId: 4663, db: { execute: async () => [{ u: a, last: new Date(T(10)) }] } } as never;
  // a: old backlog (T0) but served at T10; b: waiting since T3; c: fresh, first spend at T7
  const order = await longestWaitingFirst(ctx, sql`keeper_roundups`, [a!, b!, c!], new Map([[a!, T(0)], [b!, T(3)], [c!, T(7)]]));
  expect(order).toEqual([b, c, a]);
});
