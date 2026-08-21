CREATE TABLE "timeline_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"range_key" text NOT NULL,
	"analysis" text DEFAULT '' NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_analyses" ADD CONSTRAINT "timeline_analyses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_analyses_project_range_idx" ON "timeline_analyses" USING btree ("project_id","range_key");