import { initTRPC, TRPCError } from "@trpc/server";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { eligibility } from "./eligibility";
import { stockOf } from "./deployment";
import { indexedBlock } from "./events";
import { listStatements, StatementsUnavailable, verifyStatementBundle } from "./statements";
import { activity, crowdBooks, habit, MODES, overview, RANGES, settings, type Deps, type Range } from "./service";
import { buildApproveUsdg, buildClaimOpen, buildDeposit, buildSetMix, buildSetSettings, buildWithdraw, TxInputError } from "./tx";

export type Ctx = Deps & { headers: Headers };

// No stack traces and no internal error text over the wire: 5xx bodies say "internal error" only.
const t = initTRPC.context<Ctx>().create({
  isDev: false,
  errorFormatter: ({ shape, error }) =>
    error.code === "INTERNAL_SERVER_ERROR" ? { ...shape, message: "internal error", data: { ...shape.data, stack: undefined } } : shape,
});

const address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "not an address")
  .transform((s) => getAddress(s) as Address);
const amount = z.string().regex(/^\d{1,30}(\.\d{1,6})?$/, "decimal USDG amount, at most 6 decimals");
const range = z.enum(Object.keys(RANGES) as [Range, ...Range[]]);

/** Bad tx input is the caller's fault (400), not a server error. */
function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof TxInputError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

/** No Hidden Vault on this deployment is a 404, not a server error. */
async function hidden<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof StatementsUnavailable) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
    throw e;
  }
}

export const appRouter = t.router({
  account: t.router({
    overview: t.procedure.input(z.object({ address })).query(({ ctx, input }) => overview(ctx, input.address)),
    habit: t.procedure.input(z.object({ address, range: range.default("1M") })).query(({ ctx, input }) => habit(ctx, input.address, input.range)),
    activity: t.procedure
      .input(z.object({ address, cursor: z.string().regex(/^\d{1,20}-\d{1,9}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }))
      .query(({ ctx, input }) => activity(ctx, input.address, input.cursor, input.limit)),
    settings: t.procedure.input(z.object({ address })).query(({ ctx, input }) => settings(ctx, input.address)),
  }),
  tx: t.router({
    setSettings: t.procedure
      .input(
        z.object({
          roundTo: z.coerce.number().int(),
          multiplier: z.coerce.number().int(),
          weeklyCap: amount,
          fixedTopUp: amount,
          mode: z.enum(MODES),
        }),
      )
      .mutation(({ ctx, input }) => wrap(() => buildSetSettings(ctx.chainId, ctx.dep, input))),
    approveUsdg: t.procedure.input(z.object({ amount })).mutation(({ ctx, input }) => wrap(() => buildApproveUsdg(ctx.chainId, ctx.dep, input.amount))),
    deposit: t.procedure.input(z.object({ amount })).mutation(({ ctx, input }) => wrap(() => buildDeposit(ctx.chainId, ctx.dep, input.amount))),
    withdraw: t.procedure.input(z.object({ amount, to: address })).mutation(({ ctx, input }) => wrap(() => buildWithdraw(ctx.chainId, ctx.dep, input.amount, input.to))),
    setMix: t.procedure
      .input(z.object({ mix: z.array(z.object({ token: address, weightBps: z.number().int() })).min(1).max(5) }))
      .mutation(({ ctx, input }) => wrap(() => buildSetMix(ctx.chainId, ctx.dep, input.mix))),
    claimOpen: t.procedure
      .input(z.object({ asset: address, bookId: z.union([z.string(), z.number().int().nonnegative()]).transform(String) }))
      .mutation(({ ctx, input }) => wrap(() => buildClaimOpen(ctx.chainId, ctx.dep, input.asset, input.bookId))),
  }),
  crowd: t.router({
    books: t.procedure.input(z.object({ asset: address.optional() }).default({})).query(({ ctx, input }) => {
      if (!input.asset) return crowdBooks(ctx, ctx.dep.stocks);
      const s = stockOf(ctx.dep, input.asset);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: `unknown Stock Token ${input.asset}` });
      return crowdBooks(ctx, [s]);
    }),
  }),
  statements: t.router({
    list: t.procedure.input(z.object({ address })).query(({ ctx, input }) => hidden(() => listStatements(ctx, input.address))),
    // Stateless: the bundle is checked against the chain and nothing is stored. Shape errors come back in the verdict.
    verify: t.procedure.input(z.object({ bundle: z.unknown() })).mutation(({ ctx, input }) => hidden(() => verifyStatementBundle(ctx, input.bundle))),
  }),
  meta: t.router({
    eligibility: t.procedure.query(({ ctx }) => eligibility(ctx.headers)),
    health: t.procedure.query(async ({ ctx }) => {
      let head: bigint | null = null;
      let indexed: bigint | null = null;
      let dbOk = false;
      try {
        head = await ctx.pub.getBlockNumber();
      } catch {}
      try {
        indexed = await indexedBlock(ctx.db, ctx.chainId);
        dbOk = true;
      } catch {}
      const lag = head !== null && indexed !== null ? head - indexed : null;
      return {
        ok: head !== null && dbOk,
        chainId: ctx.chainId,
        head: head?.toString() ?? null,
        db: dbOk,
        indexer: { lastBlock: indexed?.toString() ?? null, lagBlocks: lag?.toString() ?? null },
      };
    }),
  }),
});

export type AppRouter = typeof appRouter;
