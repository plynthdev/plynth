// OWNER: apps/keeper (todo 23). Off-chain round-up sources (statement import, Plaid). The API's import and
// link routes insert rows (new events, linked sources); the keeper syncs Plaid, accrues and updates status.
// The vault stays the source of truth for what was accrued (its replay guard and weekly cap).
import { bigint, index, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A user's linked off-chain source. kind: statement | plaid. sourceKey: "statement" or the Plaid item_id.
 * secretEnc: the Plaid access token, AES-GCM sealed with KEEPER_SECRET_KEY (never stored in clear).
 * cursor: the Plaid /transactions/sync cursor. status: active | unlinked. The keeper only accrues events of
 * active sources.
 */
export const roundupSources = pgTable(
  "roundup_sources",
  {
    chainId: integer("chain_id").notNull(),
    userAddress: text("user_address").notNull(),
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    status: text("status").notNull(),
    secretEnc: text("secret_enc"),
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.userAddress, t.kind, t.sourceKey] })],
);

/**
 * One spend from an off-chain source. Dedupe key: (chain, user, rowHash) where rowHash = sha256 of the
 * normalised statement row (plus its occurrence number in the file) or of "plaid:<transaction_id>".
 * eventId is the SpendEvent id; accrualKey = keccak256(abi.encode(source, user, eventId)) is the bytes32
 * passed to vault.accrue with logIndex 0. status: new | done | skipped | failed.
 */
export const roundupEvents = pgTable(
  "roundup_events",
  {
    chainId: integer("chain_id").notNull(),
    userAddress: text("user_address").notNull(),
    rowHash: text("row_hash").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    eventId: text("event_id").notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    merchant: text("merchant"),
    status: text("status").notNull(),
    reason: text("reason"),
    accrualKey: text("accrual_key"),
    added: numeric("added", { precision: 78, scale: 0 }),
    accrueTx: text("accrue_tx"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.userAddress, t.rowHash] }), index("roundup_events_status_idx").on(t.chainId, t.status)],
);
