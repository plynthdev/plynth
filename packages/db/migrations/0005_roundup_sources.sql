CREATE TABLE "roundup_events" (
	"chain_id" integer NOT NULL,
	"user_address" text NOT NULL,
	"row_hash" text NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"event_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"merchant" text,
	"status" text NOT NULL,
	"reason" text,
	"accrual_key" text,
	"added" numeric(78, 0),
	"accrue_tx" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roundup_events_chain_id_user_address_row_hash_pk" PRIMARY KEY("chain_id","user_address","row_hash")
);
--> statement-breakpoint
CREATE TABLE "roundup_sources" (
	"chain_id" integer NOT NULL,
	"user_address" text NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"status" text NOT NULL,
	"secret_enc" text,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roundup_sources_chain_id_user_address_kind_source_key_pk" PRIMARY KEY("chain_id","user_address","kind","source_key")
);
--> statement-breakpoint
CREATE INDEX "roundup_events_status_idx" ON "roundup_events" USING btree ("chain_id","status");