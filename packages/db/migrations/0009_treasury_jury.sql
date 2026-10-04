CREATE TABLE "jury_verdicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"approvals" text NOT NULL,
	"account" text NOT NULL,
	"desk" text NOT NULL,
	"op_hash" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"bundle_json" text NOT NULL,
	"mode" text NOT NULL,
	"recommendation" text NOT NULL,
	"rule_recommendation" text NOT NULL,
	"status" text NOT NULL,
	"ticket" text,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jury_verdicts_bundle_uq" ON "jury_verdicts" USING btree ("chain_id","approvals","bundle_hash");--> statement-breakpoint
CREATE INDEX "jury_verdicts_ticket_idx" ON "jury_verdicts" USING btree ("chain_id","approvals","ticket");--> statement-breakpoint
CREATE INDEX "jury_verdicts_op_idx" ON "jury_verdicts" USING btree ("op_hash");