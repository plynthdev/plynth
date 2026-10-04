CREATE TABLE "keeper_jobs" (
	"chain_id" integer NOT NULL,
	"kind" text NOT NULL,
	"job_key" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb,
	"secret_enc" text,
	"tx_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_jobs_chain_id_kind_job_key_pk" PRIMARY KEY("chain_id","kind","job_key")
);
--> statement-breakpoint
CREATE TABLE "keeper_roundups" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"wallet" text NOT NULL,
	"to_address" text NOT NULL,
	"user_address" text,
	"spend" numeric(78, 0) NOT NULL,
	"added" numeric(78, 0),
	"status" text NOT NULL,
	"reason" text,
	"accrue_tx" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_roundups_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "keeper_jobs_status_idx" ON "keeper_jobs" USING btree ("chain_id","kind","status");--> statement-breakpoint
CREATE INDEX "keeper_roundups_status_idx" ON "keeper_roundups" USING btree ("chain_id","status");