CREATE TABLE "dimension_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"analysis" text DEFAULT '' NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_dimension_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"segment_id" uuid,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL
);
--> statement-breakpoint
DROP INDEX "user_segments_project_idx";--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "facets" jsonb;--> statement-breakpoint
ALTER TABLE "user_segments" ADD COLUMN "dimension" text DEFAULT 'overall' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_segments" ADD COLUMN "analysis" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dimension_analyses" ADD CONSTRAINT "dimension_analyses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_dimension_points" ADD CONSTRAINT "profile_dimension_points_profile_id_user_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_dimension_points" ADD CONSTRAINT "profile_dimension_points_segment_id_user_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."user_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_analyses_project_dim_idx" ON "dimension_analyses" USING btree ("project_id","dimension");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_dimension_points_profile_dim_idx" ON "profile_dimension_points" USING btree ("profile_id","dimension");--> statement-breakpoint
CREATE INDEX "user_segments_project_idx" ON "user_segments" USING btree ("project_id","dimension");