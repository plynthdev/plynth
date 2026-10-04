CREATE TABLE "treasury_exception_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"token_id" text NOT NULL,
	"desk" text,
	"action" text NOT NULL,
	"asset" text,
	"amount_usd" text,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"label" text NOT NULL,
	"issued_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nav_marks" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"nav_usd" text NOT NULL,
	"cash_bps" integer NOT NULL,
	"equity_bps" integer NOT NULL,
	"basis_bps" integer NOT NULL,
	"hold" boolean NOT NULL,
	"weights" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"hour" bigint NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"action_ids" integer[] NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "treasury_exception_requests_account_idx" ON "treasury_exception_requests" USING btree ("chain_id","account","status");--> statement-breakpoint
CREATE INDEX "treasury_mcp_tokens_account_idx" ON "treasury_mcp_tokens" USING btree ("chain_id","account");--> statement-breakpoint
CREATE INDEX "nav_marks_treasury_ts_idx" ON "nav_marks" USING btree ("chain_id","account","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_receipts_hour_uq" ON "treasury_receipts" USING btree ("chain_id","account","hour");