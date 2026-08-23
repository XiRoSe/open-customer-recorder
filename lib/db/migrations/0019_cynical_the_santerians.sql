CREATE TABLE "timeline_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"engaged" integer DEFAULT 0 NOT NULL,
	"engaged_new" integer DEFAULT 0 NOT NULL,
	"frustrated" integer DEFAULT 0 NOT NULL,
	"new_visitor_sessions" integer DEFAULT 0 NOT NULL,
	"duration_sum_ms" bigint DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"tagged" integer DEFAULT 0 NOT NULL,
	"by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clicks_by_device" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"friction_by_kind" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_tag" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_device" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_browser" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_country" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_referrer_host" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_entry_path" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_entry_friction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_rollups" ADD CONSTRAINT "timeline_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_rollups_project_hour_idx" ON "timeline_rollups" USING btree ("project_id","hour_start");