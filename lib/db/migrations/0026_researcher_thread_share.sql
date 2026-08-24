ALTER TABLE "researcher_threads" ADD COLUMN "share_token" text;--> statement-breakpoint
CREATE INDEX "researcher_threads_share_token_idx" ON "researcher_threads" USING btree ("share_token");--> statement-breakpoint
ALTER TABLE "researcher_threads" ADD CONSTRAINT "researcher_threads_share_token_unique" UNIQUE("share_token");