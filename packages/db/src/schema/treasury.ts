// OWNER: apps/treasury (todos 10-14). Only the treasury service writes these tables.
// Tables still to come from later treasury todos: treasuries, policies, desk_keys, nav_marks, positions,
// feeds.
import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One row per desk decision (todo 12): every operation a desk planned, whether it was sent, rejected by the
 * eth_call simulation (reason_code = the PolicyGuard rule code, or null with `reason` = the revert name),
 * skipped by the desk itself (feeds on hold, nothing to do), or a marker such as `rebalance_done`.
 */
export const deskActions = pgTable(
  "desk_actions",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    desk: text("desk").notNull(), // "cash" | "equity"
    action: text("action").notNull(), // deposit | redeem | buy | sell | beacon_commit | beacon_reveal | rebalance_done | skip
    status: text("status").notNull(), // sent | rejected | reverted | skipped | done
    reasonCode: integer("reason_code"),
    reason: text("reason"),
    adapter: text("adapter"),
    asset: text("asset"),
    amount: text("amount"), // raw units as a decimal string
    notionalUsd: text("notional_usd"), // USD 1e18 as a decimal string
    beaconKey: text("beacon_key"),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("desk_actions_account_desk_idx").on(t.account, t.desk, t.createdAt),
    index("desk_actions_beacon_idx").on(t.beaconKey, t.action),
  ],
);

/**
 * One row per period-close statement the close service built (todo 13). `bundle_json` is the exact text whose
 * keccak256 is committed on-chain as `bundleHash` (text, not jsonb: jsonb would reorder keys and change the
 * hash). The CFO pack renders only from the on-chain `PeriodClosed` event plus the row whose hash matches.
 * status: signed (built + signed, not yet on-chain) | committed | stale (chain moved before inclusion) | failed
 */
export const closes = pgTable(
  "closes",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    periodClose: text("period_close").notNull(),
    account: text("account").notNull(),
    periodEnd: bigint("period_end", { mode: "bigint" }).notNull(),
    navUsd: text("nav_usd").notNull(), // USD 1e18 as a decimal string
    bundleHash: text("bundle_hash").notNull(),
    bundleJson: text("bundle_json").notNull(),
    signature: text("signature").notNull(),
    lastDeskActionId: integer("last_desk_action_id").notNull().default(0),
    status: text("status").notNull(),
    closeIndex: integer("close_index"),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("closes_bundle_uq").on(t.chainId, t.periodClose, t.bundleHash),
    index("closes_period_idx").on(t.chainId, t.periodClose, t.periodEnd),
  ],
);

/**
 * One row per exception the model jury deliberated on (todo 26). `bundle_json` is the exact text whose
 * keccak256 (`bundle_hash`) went to BoardApprovals.request as `juryVerdictCid` (text, not jsonb, for the same
 * reason as closes). The jury only advises; `ticket` is the board ticket the desk opened with it.
 * recommendation: approve | reject | none (models), rule_recommendation: approve | reject (rule juror).
 * status: deliberated (stored, not yet on-chain) | requested (ticket opened) | failed
 */
export const juryVerdicts = pgTable(
  "jury_verdicts",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    approvals: text("approvals").notNull(),
    account: text("account").notNull(),
    desk: text("desk").notNull(),
    opHash: text("op_hash").notNull(),
    bundleHash: text("bundle_hash").notNull(),
    bundleJson: text("bundle_json").notNull(),
    mode: text("mode").notNull(), // models+rules | rules-only
    recommendation: text("recommendation").notNull(),
    ruleRecommendation: text("rule_recommendation").notNull(),
    status: text("status").notNull(),
    ticket: text("ticket"),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jury_verdicts_bundle_uq").on(t.chainId, t.approvals, t.bundleHash),
    index("jury_verdicts_ticket_idx").on(t.chainId, t.approvals, t.ticket),
    index("jury_verdicts_op_idx").on(t.opHash),
  ],
);

/**
 * Reconciler breaks (todo 29, spec §3): every hour each venue's own statement, the on-chain PositionMirror and
 * the internal fill ledger are compared; a disagreement is one row here (one open row per break key; later
 * hours bump `last_seen_at`). A period close refuses to commit while any row of the account is `open`.
 * status: open | explained (a human wrote why; `explanation` + `explained_by` are required) | resolved (the
 * sources agree again; it still needs no explanation because nothing was wrong at close time).
 */
export const exceptions = pgTable(
  "exceptions",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    kind: text("kind").notNull(), // reconcile.position | reconcile.equity | reconcile.stale_mirror | reconcile.venue_error
    key: text("key").notNull(), // stable per break: kind:venue:underlying
    venue: text("venue").notNull(),
    underlying: text("underlying"),
    detail: jsonb("detail").notNull(),
    status: text("status").notNull(),
    explanation: text("explanation"),
    explainedBy: text("explained_by"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("exceptions_account_status_idx").on(t.chainId, t.account, t.status), index("exceptions_key_idx").on(t.chainId, t.account, t.key, t.status)],
);

/**
 * The internal ledger of perp fills (todo 29): every order a hedge/basis desk got filled at a venue, as signed
 * Stock Token base units (+ bought, - sold). Ledger position = sum per (account, venue, underlying).
 */
export const venueFills = pgTable(
  "venue_fills",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    venue: text("venue").notNull(),
    underlying: text("underlying").notNull(),
    desk: text("desk").notNull(), // hedge | basis
    tokens: text("tokens").notNull(), // signed base units as a decimal string
    orderId: text("order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("venue_fills_pos_idx").on(t.chainId, t.account, t.venue, t.underlying)],
);
