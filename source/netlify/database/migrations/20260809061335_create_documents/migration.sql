CREATE TABLE "documents" (
	"id" text PRIMARY KEY,
	"category" text NOT NULL,
	"bucket" text,
	"blob_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" integer NOT NULL,
	"title" text,
	"uploaded_by" text,
	"tag" text,
	"source" text,
	"party" text,
	"rank" text,
	"swing" text,
	"filed_on" text,
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "documents_category_idx" ON "documents" ("category","bucket");