// OWNER: app/src/indexer (todo 04). Only the indexer writes these tables; everything else reads them.
// Every indexer-owned table is named ev_*. Typed projections added later follow ev_<contract>_<event>
// and must carry chain_id + block_number so the indexer's reorg rewind can delete them.
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const evCursors = pgTable("ev_cursors", {
  stream: text("stream").primaryKey(),
  chainId: integer("chain_id").notNull(),
  contract: text("contract").notNull(),
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
  lastBlockHash: text("last_block_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evLogs = pgTable(
  "ev_logs",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    address: text("address").notNull(),
    topic0: text("topic0"),
    dataJson: jsonb("data_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }),
    index("ev_logs_chain_block_idx").on(t.chainId, t.blockNumber),
    index("ev_logs_address_topic0_idx").on(t.address, t.topic0),
  ],
);
