ALTER TABLE "dimension_analyses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_dimension_points" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "researcher_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "researcher_threads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timeline_analyses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timeline_rollups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_segments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "dimension_analyses" CASCADE;--> statement-breakpoint
DROP TABLE "leads" CASCADE;--> statement-breakpoint
DROP TABLE "profile_dimension_points" CASCADE;--> statement-breakpoint
DROP TABLE "researcher_messages" CASCADE;--> statement-breakpoint
DROP TABLE "researcher_threads" CASCADE;--> statement-breakpoint
DROP TABLE "timeline_analyses" CASCADE;--> statement-breakpoint
DROP TABLE "timeline_rollups" CASCADE;--> statement-breakpoint
DROP TABLE "user_segments" CASCADE;--> statement-breakpoint
ALTER TABLE "user_profiles" DROP CONSTRAINT "user_profiles_segment_id_user_segments_id_fk";
--> statement-breakpoint
DROP INDEX "user_profiles_segment_idx";--> statement-breakpoint
ALTER TABLE "app_settings" DROP COLUMN "clustering_enabled";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "segment_id";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "map_x";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "map_y";