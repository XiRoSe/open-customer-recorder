CREATE TABLE "session_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"admin_email" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_views" ADD CONSTRAINT "session_views_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_views_session_admin_idx" ON "session_views" USING btree ("session_id","admin_email");--> statement-breakpoint
CREATE INDEX "session_views_admin_idx" ON "session_views" USING btree ("admin_email","session_id");