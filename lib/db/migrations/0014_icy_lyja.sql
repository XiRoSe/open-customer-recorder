CREATE TABLE "user_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "clustering_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "segment_id" uuid;--> statement-breakpoint
ALTER TABLE "user_segments" ADD CONSTRAINT "user_segments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_segments_project_idx" ON "user_segments" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_segment_id_user_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."user_segments"("id") ON DELETE set null ON UPDATE no action;