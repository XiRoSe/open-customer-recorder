-- Visitor-key expression index. The first-seen LATERAL, the Users page
-- aggregates, and the clusters activity filter all match on
-- coalesce(user_id, anon_id), which no plain column index serves —
-- without this, each of those reads scans the whole project's sessions.
-- (Hand-written: drizzle's schema DSL can't model expression indexes.)
CREATE INDEX IF NOT EXISTS "sessions_project_visitor_started_idx"
  ON "sessions" ("project_id", (coalesce("user_id", "anon_id")), "started_at");
