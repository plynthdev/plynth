CREATE TABLE "desk_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"desk" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" integer,
	"reason" text,
	"adapter" text,
	"asset" text,
	"amount" text,
	"notional_usd" text,
	"beacon_key" text,
	"tx_hash" text,
	"block_number" bigint,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "desk_actions_account_desk_idx" ON "desk_actions" USING btree ("account","desk","created_at");--> statement-breakpoint
CREATE INDEX "desk_actions_beacon_idx" ON "desk_actions" USING btree ("beacon_key","action");