ALTER TABLE "session_summaries" ADD COLUMN "clicks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill from the digest's true click count (steps are elided to 60).
UPDATE "session_summaries" SET "clicks" = coalesce((digest->'stats'->>'clickCount')::int, 0);
