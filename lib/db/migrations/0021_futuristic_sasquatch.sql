DROP INDEX "sessions_anon_idx";--> statement-breakpoint
CREATE INDEX "profile_dimension_points_segment_idx" ON "profile_dimension_points" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "session_tags_rule_idx" ON "session_tags" USING btree ("tag_rule_id");--> statement-breakpoint
CREATE INDEX "user_profiles_segment_idx" ON "user_profiles" USING btree ("segment_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "blob_path";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "viewed_at";