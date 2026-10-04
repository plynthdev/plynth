CREATE TABLE "closes" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"period_close" text NOT NULL,
	"account" text NOT NULL,
	"period_end" bigint NOT NULL,
	"nav_usd" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"bundle_json" text NOT NULL,
	"signature" text NOT NULL,
	"last_desk_action_id" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"close_index" integer,
	"tx_hash" text,
	"block_number" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "closes_bundle_uq" ON "closes" USING btree ("chain_id","period_close","bundle_hash");--> statement-breakpoint
CREATE INDEX "closes_period_idx" ON "closes" USING btree ("chain_id","period_close","period_end");