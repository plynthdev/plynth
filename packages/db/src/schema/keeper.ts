// OWNER: apps/keeper (todo 07). Only the keeper writes these tables; everything else reads them.
// Users, books, orders and allocations are not copied here: they are read from ev_logs (indexer) and
// from the contracts themselves, which stay the source of truth.
import { index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per indexed USDG Transfer out of a linked spending wallet (the round-up source).
 * status: pending (seen, not yet accrued), done (accrued on-chain, or the vault already had it),
 * skipped (not a round-up: transfer into a Plynth contract, or wallet not linked at that block),
 * failed (pre-simulation reverted for another reason; retried next pass, attempts counts them).
 */
export const keeperRoundups = pgTable(
  "keeper_roundups",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    wallet: text("wallet").notNull(),
    toAddress: text("to_address").notNull(),
    userAddress: text("user_address"),
    spend: numeric("spend", { precision: 78, scale: 0 }).notNull(),
    added: numeric("added", { precision: 78, scale: 0 }),
    status: text("status").notNull(),
    reason: text("reason"),
    accrueTx: text("accrue_tx"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }), index("keeper_roundups_status_idx").on(t.chainId, t.status)],
);

/**
 * Everything else the keeper schedules: kind = topup | sweep | beacon | execute, jobKey unique per kind.
 * Beacon rows hold the commit-reveal secret, AES-GCM encrypted with KEEPER_SECRET_KEY (secretEnc); the
 * plaintext secret is never stored. status: secret (stored, not committed), committed, revealed, expired,
 * done, failed.
 */
export const keeperJobs = pgTable(
  "keeper_jobs",
  {
    chainId: integer("chain_id").notNull(),
    kind: text("kind").notNull(),
    jobKey: text("job_key").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload"),
    secretEnc: text("secret_enc"),
    txHash: text("tx_hash"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.kind, t.jobKey] }), index("keeper_jobs_status_idx").on(t.chainId, t.kind, t.status)],
);
