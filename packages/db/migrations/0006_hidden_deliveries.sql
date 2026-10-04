CREATE TABLE "keeper_hidden_deliveries" (
	"chain_id" integer NOT NULL,
	"asset" text NOT NULL,
	"book_id" numeric(78, 0) NOT NULL,
	"user_address" text NOT NULL,
	"raw" numeric(78, 0),
	"commitment" text,
	"status" text NOT NULL,
	"reason" text,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_hidden_deliveries_chain_id_asset_book_id_user_address_pk" PRIMARY KEY("chain_id","asset","book_id","user_address")
);
