// OWNER: apps/treasury (todos 10-14). Only the treasury service writes these tables.
// Tables still to come from later treasury todos: treasuries, policies, desk_keys, nav_marks, positions,
// exceptions, feeds.
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
