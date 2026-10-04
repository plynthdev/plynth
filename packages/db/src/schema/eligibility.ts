// OWNER: apps/eligibility (todo 22). One row per screening decision. No IP address is ever stored:
// only the derived country code (or null) and the time. Read by support tooling and the API.
import { bigserial, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * allowed: the screen passed and an attestation was signed (expiry set); otherwise reason says why.
 * flags: bitmask of checks that passed (1 self-attested, 2 IP country, 4 sanctions), same as the registry.
 */
export const eligibilityDecisions = pgTable(
  "eligibility_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    allowed: boolean("allowed").notNull(),
    reason: text("reason").notNull(),
    country: text("country"),
    flags: integer("flags").notNull(),
    expiry: timestamp("expiry", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("eligibility_decisions_address_idx").on(t.chainId, t.address, t.createdAt)],
);
