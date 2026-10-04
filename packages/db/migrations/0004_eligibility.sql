CREATE TABLE "eligibility_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"allowed" boolean NOT NULL,
	"reason" text NOT NULL,
	"country" text,
	"flags" integer NOT NULL,
	"expiry" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eligibility_decisions_address_idx" ON "eligibility_decisions" USING btree ("chain_id","address","created_at");