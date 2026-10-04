CREATE TABLE "exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"venue" text NOT NULL,
	"underlying" text,
	"detail" jsonb NOT NULL,
	"status" text NOT NULL,
	"explanation" text,
	"explained_by" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "venue_fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"venue" text NOT NULL,
	"underlying" text NOT NULL,
	"desk" text NOT NULL,
	"tokens" text NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "exceptions_account_status_idx" ON "exceptions" USING btree ("chain_id","account","status");--> statement-breakpoint
CREATE INDEX "exceptions_key_idx" ON "exceptions" USING btree ("chain_id","account","key","status");--> statement-breakpoint
CREATE INDEX "venue_fills_pos_idx" ON "venue_fills" USING btree ("chain_id","account","venue","underlying");