ALTER TABLE "documents" ADD COLUMN "person" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "qual_code" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expires_on" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "checksum" text;--> statement-breakpoint
CREATE INDEX "documents_folder_idx" ON "documents" ("folder","checksum");