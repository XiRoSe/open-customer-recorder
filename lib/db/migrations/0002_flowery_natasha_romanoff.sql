ALTER TABLE "sessions" ALTER COLUMN "blob_path" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "blob_data" "bytea" DEFAULT ''::bytea NOT NULL;