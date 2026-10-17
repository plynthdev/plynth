import { initTRPC, TRPCError } from "@trpc/server";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { eligibility } from "./routes/eligibility";
import { stockOf } from "@/chain/deployment";
import { indexedBlock } from "./events";
import { listStatements, StatementsUnavailable, verifyStatementBundle } from "./routes/statements";
import { proofNonce, verifyThreshold } from "./routes/proofs";
import { activity, crowdBooks, habit, MODES, overview, RANGES, settings, type Deps, type Range } from "./service";
import {
  actionsList,
  CFO_FORMATS,
  CfoPackRefused,
  cfoPack,
  closeGet,
  closeList,
  deskList,
  exceptionsList,
  marketplaceList,
  navHistory,
  ReceiptNotFound,
  receiptsProof,
  receiptsRoot,
  navLatest,
  policyCurrent,
  policyDiff,
  policyPropose,
  positionsList,
  templates,
  treasuryCreate,
  TreasuryNotFound,
} from "./routes/treasury";
import { DeskIndexBehind } from "./desk-index";
import { issueMcpToken, listMcpTokens, McpAuthError, McpUnavailable, requireTreasuryReader, revokeMcpToken } from "./routes/mcp-tokens";
import { buildApproveUsdg, buildClaimOpen, buildDeposit, buildSetHiddenKeys, buildSetMix, buildSetSettings, buildWithdraw, TxInputError } from "./tx";

export type Ctx = Deps & { headers: Headers };

// No stack traces and no internal error text over the wire: 5xx bodies say "internal error" only.
const t = initTRPC.context<Ctx>().create({
  isDev: false,
  errorFormatter: ({ shape, error }) =>
    error.code === "INTERNAL_SERVER_ERROR" ? { ...shape, message: "internal error", data: { ...shape.data, stack: undefined } } : shape,
});

/**
 * Review v2 (V2-L15 / API-2): treasury reads are default-deny. Every procedure in a treasury namespace needs an MCP
 * token scoped to the input's `account` (requireTreasuryReader) unless it is listed in TREASURY_PUBLIC. L-14 gated
 * only actions/exceptions/receipt proofs/token lists, so close.list, close.get, cfo.pack and desk.list still served
 * desk decisions, their free-text reasons and pending rows to anyone. A new procedure is private until listed here.
 * The public ones serve what the chain already shows (policy, NAV and positions read live, receipt roots) or build
 * transactions and board-signed requests.
 */
export const TREASURY_NAMESPACES = new Set(["treasury", "policy", "desk", "nav", "receipts", "marketplace", "mcpTokens", "positions", "actions", "exceptions", "close", "cfo"]);
export const TREASURY_PUBLIC = new Set([
  "treasury.templates",
  "treasury.create",
  "marketplace.list",
  "policy.current",
  "policy.diff",
  "policy.propose",
  "nav.latest",
  "nav.history",
  "positions.list",
  "receipts.root",
  "mcpTokens.issue",
  "mcpTokens.revoke",
]);
export const isTreasuryPrivate = (path: string) => TREASURY_NAMESPACES.has(path.split(".")[0]!) && !TREASURY_PUBLIC.has(path);

const treasuryGate = t.middleware(async ({ ctx, path, getRawInput, next }) => {
  if (isTreasuryPrivate(path)) {
    const raw = (await getRawInput().catch(() => undefined)) as { account?: unknown } | undefined;
    const a = typeof raw?.account === "string" && isAddress(raw.account, { strict: false }) ? (getAddress(raw.account) as Address) : undefined;
    if (!a) throw new TRPCError({ code: "UNAUTHORIZED", message: "this treasury record needs an MCP token for the treasury (Authorization: Bearer pmcp_...)" });
    await treasury(() => requireTreasuryReader(ctx, ctx.headers, a));
  }
  return next();
});
/** Every procedure starts here, so the treasury gate cannot be forgotten. */
const proc = t.procedure.use(treasuryGate);

const address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "not an address")
  .transform((s) => getAddress(s) as Address);
const amount = z.string().regex(/^\d{1,30}(\.\d{1,6})?$/, "decimal USDG amount, at most 6 decimals");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "bytes32 hex").transform((s) => s as `0x${string}`);
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

/** Treasury errors: not a treasury / nothing committed -> 404, bad template -> 400, bundle mismatch -> 412. */
async function treasury<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof TreasuryNotFound || e instanceof ReceiptNotFound) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
    if (e instanceof McpAuthError) throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
    if (e instanceof McpUnavailable) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: e.message });
    if (e instanceof TxInputError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    if (e instanceof CfoPackRefused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
    if (e instanceof DeskIndexBehind) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: e.message });
    throw e;
  }
}

const tAccount = z.object({ account: address });

/** Off-chain treasury records: only with an MCP token scoped to the treasury (audit L-14; see requireTreasuryReader). */
async function privateRead<T>(ctx: Ctx, account: Address, f: () => Promise<T>): Promise<T> {
  return treasury(async () => {
    await requireTreasuryReader(ctx, ctx.headers, account);
    return f();
  });
}
const templateInput = z
  .object({
    templateName: z.string().optional(),
    template: z.record(z.string(), z.unknown()).optional(),
    controller: address,
    network: z.enum(["mainnet", "testnet"]).optional(),
  })
  .refine((v) => (v.templateName === undefined) !== (v.template === undefined), "pass exactly one of templateName or template");

export const appRouter = t.router({
  account: t.router({
    overview: proc.input(z.object({ address })).query(({ ctx, input }) => overview(ctx, input.address)),
    habit: proc.input(z.object({ address, range: range.default("1M") })).query(({ ctx, input }) => habit(ctx, input.address, input.range)),
    activity: proc
      .input(z.object({ address, cursor: z.string().regex(/^\d{1,20}-\d{1,9}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }))
      .query(({ ctx, input }) => activity(ctx, input.address, input.cursor, input.limit)),
    settings: proc.input(z.object({ address })).query(({ ctx, input }) => settings(ctx, input.address)),
  }),
  tx: t.router({
    setSettings: proc
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
    approveUsdg: proc.input(z.object({ amount })).mutation(({ ctx, input }) => wrap(() => buildApproveUsdg(ctx.chainId, ctx.dep, input.amount))),
    deposit: proc.input(z.object({ amount })).mutation(({ ctx, input }) => wrap(() => buildDeposit(ctx.chainId, ctx.dep, input.amount))),
    withdraw: proc.input(z.object({ amount, to: address })).mutation(({ ctx, input }) => wrap(() => buildWithdraw(ctx.chainId, ctx.dep, input.amount, input.to))),
    setMix: proc
      .input(z.object({ mix: z.array(z.object({ token: address, weightBps: z.number().int() })).min(1).max(5) }))
      .mutation(({ ctx, input }) => wrap(() => buildSetMix(ctx.chainId, ctx.dep, input.mix))),
    setHiddenKeys: proc
      .input(z.object({ ownerPk: bytes32, viewingPub: bytes32 }))
      .mutation(({ ctx, input }) => wrap(() => buildSetHiddenKeys(ctx.chainId, ctx.dep, input.ownerPk, input.viewingPub))),
    claimOpen: proc
      .input(z.object({ asset: address, bookId: z.union([z.string(), z.number().int().nonnegative()]).transform(String) }))
      .mutation(({ ctx, input }) => wrap(() => buildClaimOpen(ctx.chainId, ctx.dep, input.asset, input.bookId))),
  }),
  crowd: t.router({
    books: proc.input(z.object({ asset: address.optional() }).default({})).query(({ ctx, input }) => {
      if (!input.asset) return crowdBooks(ctx, ctx.dep.stocks);
      const s = stockOf(ctx.dep, input.asset);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: `unknown Stock Token ${input.asset}` });
      return crowdBooks(ctx, [s]);
    }),
  }),
  statements: t.router({
    list: proc.input(z.object({ address })).query(({ ctx, input }) => hidden(() => listStatements(ctx, input.address))),
    // Stateless: the bundle is checked against the chain and nothing is stored. Shape errors come back in the verdict.
    verify: proc.input(z.object({ bundle: z.unknown() })).mutation(({ ctx, input }) => hidden(() => verifyStatementBundle(ctx, input.bundle))),
  }),
  proofs: t.router({
    // Stateless: checks a threshold proof for the caller's own (verifier, requestId); nothing is stored.
    verify: proc
      .input(z.object({ proof: z.unknown(), verifier: address, requestId: bytes32 }))
      .mutation(({ ctx, input }) => hidden(() => verifyThreshold(ctx, input.proof, input.verifier, input.requestId))),
    nonce: proc.input(z.object({ verifier: address, requestId: bytes32 })).query(({ ctx, input }) => hidden(async () => proofNonce(ctx, input.verifier, input.requestId))),
  }),
  treasury: t.router({
    templates: proc.query(() => templates()),
    create: proc
      .input(templateInput.and(z.object({ board: address, templateId: z.coerce.number().int().positive().optional() })))
      .mutation(({ ctx, input }) => treasury(() => treasuryCreate(ctx, input as any))),
  }),
  policy: t.router({
    current: proc.input(tAccount).query(({ ctx, input }) => treasury(() => policyCurrent(ctx, input.account))),
    diff: proc.input(tAccount.and(templateInput)).query(({ ctx, input }) => treasury(() => policyDiff(ctx, input.account, input as any))),
    propose: proc.input(tAccount.and(templateInput)).mutation(({ ctx, input }) => treasury(() => policyPropose(ctx, input.account, input as any))),
  }),
  desk: t.router({
    list: proc.input(tAccount).query(({ ctx, input }) => treasury(() => deskList(ctx, input.account))),
  }),
  nav: t.router({
    latest: proc.input(tAccount).query(({ ctx, input }) => treasury(() => navLatest(ctx, input.account))),
    // 60 s marks from the valuer service (todo 30): 1440 = one day.
    history: proc
      .input(tAccount.extend({ limit: z.coerce.number().int().min(1).max(1440).default(60), from: z.coerce.date().optional(), to: z.coerce.date().optional() }))
      .query(({ ctx, input }) => treasury(() => navHistory(ctx, input.account, input))),
  }),
  receipts: t.router({
    root: proc
      .input(tAccount.extend({ hour: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v)) }))
      .query(({ ctx, input }) => treasury(() => receiptsRoot(ctx, input.account, input.hour))),
    proof: proc
      .input(tAccount.extend({ actionId: z.coerce.number().int().positive() }))
      .query(({ ctx, input }) => privateRead(ctx, input.account, () => receiptsProof(ctx, input.account, input.actionId))),
  }),
  marketplace: t.router({
    list: proc.query(({ ctx }) => treasury(() => marketplaceList(ctx))),
  }),
  mcpTokens: t.router({
    // The board signs issueMessage(...) (EOA or Safe/ERC-1271); the token is returned once and never stored.
    issue: proc
      .input(
        tAccount.extend({
          label: z.string(),
          issuedAt: z.coerce.number().int().positive(),
          expiresAt: z.coerce.number().int().positive(),
          signature: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((s) => s as `0x${string}`),
        }),
      )
      .mutation(({ ctx, input }) => treasury(() => issueMcpToken(ctx, input.account, input))),
    revoke: proc
      .input(tAccount.extend({ id: z.string().regex(/^[0-9a-f]{32}$/), issuedAt: z.coerce.number().int().positive(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((s) => s as `0x${string}`) }))
      .mutation(({ ctx, input }) => treasury(() => revokeMcpToken(ctx, input.account, input))),
    list: proc.input(tAccount).query(({ ctx, input }) => privateRead(ctx, input.account, () => listMcpTokens(ctx, input.account))),
  }),
  positions: t.router({
    list: proc.input(tAccount).query(({ ctx, input }) => treasury(() => positionsList(ctx, input.account))),
  }),
  actions: t.router({
    list: proc
      .input(
        tAccount.extend({
          desk: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
          cursor: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      )
      .query(({ ctx, input }) => privateRead(ctx, input.account, () => actionsList(ctx, input.account, input))),
  }),
  exceptions: t.router({
    list: proc
      .input(tAccount.extend({ status: z.enum(["open", "explained", "resolved"]).optional() }))
      .query(({ ctx, input }) => privateRead(ctx, input.account, () => exceptionsList(ctx, input.account, input.status))),
  }),
  close: t.router({
    list: proc.input(tAccount).query(({ ctx, input }) => treasury(() => closeList(ctx, input.account))),
    get: proc
      .input(tAccount.extend({ index: z.coerce.number().int().min(0) }))
      .query(({ ctx, input }) => treasury(() => closeGet(ctx, input.account, input.index))),
  }),
  cfo: t.router({
    pack: proc
      .input(tAccount.extend({ periodEnd: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v)), format: z.enum(CFO_FORMATS).default("json") }))
      .query(({ ctx, input }) => treasury(() => cfoPack(ctx, input.account, input.periodEnd, input.format))),
  }),
  meta: t.router({
    eligibility: proc.query(({ ctx }) => eligibility(ctx.headers)),
    health: proc.query(async ({ ctx }) => {
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
