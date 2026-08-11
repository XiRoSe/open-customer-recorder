CREATE TABLE "session_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"tag_rule_id" uuid NOT NULL,
	"tagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_tags" ADD CONSTRAINT "session_tags_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tags" ADD CONSTRAINT "session_tags_tag_rule_id_tag_rules_id_fk" FOREIGN KEY ("tag_rule_id") REFERENCES "public"."tag_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rules" ADD CONSTRAINT "tag_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_tags_session_rule_idx" ON "session_tags" USING btree ("session_id","tag_rule_id");--> statement-breakpoint
CREATE INDEX "session_tags_session_idx" ON "session_tags" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tag_rules_project_idx" ON "tag_rules" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "is_signed_up";--> statement-breakpoint
-- Seed the two default rules on every existing project. Sessions aren't
-- retroactively tagged by this migration alone — trigger the apply
-- endpoint per rule after deploy (see docs/superpowers/specs/2026-08-11-tag-rules-system-design.md).
INSERT INTO "tag_rules" ("project_id", "name", "kind", "value")
SELECT "id", 'Signed up', 'url_contains', 'register' FROM "projects";--> statement-breakpoint
INSERT INTO "tag_rules" ("project_id", "name", "kind", "value")
SELECT "id", 'Returning', 'session_count_gte', '2' FROM "projects";