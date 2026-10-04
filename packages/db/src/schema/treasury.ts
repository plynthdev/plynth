// OWNER: apps/treasury (todos 10-14). Only the treasury service writes these tables.
// Tables still to come from later treasury todos: treasuries, policies, desk_keys, nav_marks, positions,
// exceptions, closes, feeds.
import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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
