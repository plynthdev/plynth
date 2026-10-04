CREATE TABLE "treasury_webhook_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"last_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"event_key" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"ok" boolean NOT NULL,
	"status" integer,
	"attempts" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "treasury_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_webhook_deliveries_uq" ON "treasury_webhook_deliveries" USING btree ("webhook_id","event_key");--> statement-breakpoint
CREATE INDEX "treasury_webhook_deliveries_retry_idx" ON "treasury_webhook_deliveries" USING btree ("ok","attempts");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_webhooks_uq" ON "treasury_webhooks" USING btree ("chain_id","account","url");--> statement-breakpoint
CREATE INDEX "treasury_webhooks_account_idx" ON "treasury_webhooks" USING btree ("chain_id","account","active");