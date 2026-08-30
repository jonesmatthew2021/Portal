CREATE TABLE "portal_state" (
	"id" text PRIMARY KEY,
	"data" jsonb NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
