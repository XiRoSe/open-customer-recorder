CREATE TABLE "session_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"digest" jsonb NOT NULL,
	"digest_version" integer NOT NULL,
	"narrative" text NOT NULL,
	"insights" jsonb NOT NULL,
	"intent_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_summaries_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "session_summaries" ADD CONSTRAINT "session_summaries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_summaries_status_idx" ON "session_summaries" USING btree ("status","next_retry_at");