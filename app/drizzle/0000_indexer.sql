CREATE TABLE "ev_cursors" (
	"stream" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"contract" text NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ev_logs" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"address" text NOT NULL,
	"topic0" text,
	"data_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_logs_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "ev_logs_chain_block_idx" ON "ev_logs" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "ev_logs_address_topic0_idx" ON "ev_logs" USING btree ("address","topic0");