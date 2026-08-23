import { pgTable, uuid, text, timestamp, integer, boolean, bigint, index, uniqueIndex, customType, jsonb, doublePrecision } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Admin accounts. Seeded at boot from the legacy env credentials
// (ADMINS_CREDS / ADMIN_EMAIL+ADMIN_PASSWORD) so upgrading deploys keep
// their logins; after that the DB is the source of truth and the Team
// card in Settings manages rows. `role` gates team mutations ('owner')
// vs. everything else ('member'). Deactivated rows keep their history
// (session_views etc. key on email) but can no longer log in.
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('member'), // 'owner' | 'member'
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  projectKey: text('project_key').notNull().unique(),
  privacyMode: text('privacy_mode').notNull().default('default'),
  retentionDays: integer('retention_days').notNull().default(30),
  // Hard cap on one recorded session's length. The server enforces it at
  // ingest; the tracker adopts it from the first events response.
  maxSessionMinutes: integer('max_session_minutes').notNull().default(5),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  anonId: text('anon_id').notNull(),
  userId: text('user_id'),
  email: text('email'),
  displayName: text('display_name'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  pageUrl: text('page_url'),
  // document.referrer at session start — where the visitor came from.
  referrer: text('referrer'),
  pageCount: integer('page_count').notNull().default(0),
  eventCount: integer('event_count').notNull().default(0),
  country: text('country'),
  browser: text('browser'),
  os: text('os'),
  userAgent: text('user_agent'),
  blobBytes: bigint('blob_bytes', { mode: 'number' }).notNull().default(0),
  // Gzipped event blob stored inline so we don't need a Railway volume.
  // Multiple gzip members concatenated — readable as a single decompress.
  blobData: customType<{ data: Buffer; default: false }>({
    dataType() { return 'bytea'; },
  })('blob_data').default(sql`''::bytea`).notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectStartedIdx: index('sessions_project_started_idx').on(t.projectId, t.startedAt),
  userIdx: index('sessions_user_idx').on(t.projectId, t.userId),
  // NOTE: no (project_id, anon_id) index — it was a strict prefix of
  // lastActivityIdx (pure write amplification). The visitor-key
  // expression index lives in migration 0021 (drizzle can't model it).
  lastActivityIdx: index('sessions_last_activity_idx').on(t.projectId, t.anonId, t.lastActivityAt),
}));

// Per-admin "viewed" tracking. One row per (session, admin) that has been
// opened. admin_email is the per-admin key (auth is env-based; no users
// table).
export const sessionViews = pgTable('session_views', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  adminEmail: text('admin_email').notNull(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Idempotent upserts on open + "has this admin viewed this session?" lookups.
  sessionAdminIdx: uniqueIndex('session_views_session_admin_idx').on(t.sessionId, t.adminEmail),
  adminIdx: index('session_views_admin_idx').on(t.adminEmail, t.sessionId),
}));

// Admin-editable rules that tag sessions. Two kinds today:
// 'url_contains' — value is a case-insensitive substring checked against
// every URL the session visited (see lib/tag-rules.ts).
// 'session_count_gte' — value is a stringified threshold checked against
// how many prior sessions the same anon_id has had.
export const tagRules = pgTable('tag_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  // One of lib/tag-rules.ts TAG_COLORS. Validated at the app layer, same
  // as `kind` — not a DB check constraint.
  color: text('color').notNull().default('green'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('tag_rules_project_idx').on(t.projectId),
}));

// Which sessions matched which rule. Sticky — a session keeps a tag once
// applied, even if the rule is later disabled or edited. One row per
// (session, rule); `on conflict do nothing` on the unique index makes
// applying a rule idempotent.
export const sessionTags = pgTable('session_tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  tagRuleId: uuid('tag_rule_id').notNull().references(() => tagRules.id, { onDelete: 'cascade' }),
  taggedAt: timestamp('tagged_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sessionRuleIdx: uniqueIndex('session_tags_session_rule_idx').on(t.sessionId, t.tagRuleId),
  sessionIdx: index('session_tags_session_idx').on(t.sessionId),
  // Rule deletions cascade through here — without this, each delete
  // seq-scans the table.
  ruleIdx: index('session_tags_rule_idx').on(t.tagRuleId),
}));

// Anon_ids that should never be recorded — e.g. admin/maintenance
// browsing of the customer site itself. Checked at ingest, before any
// session row is created or blob stored (see app/api/ingest/v2/events).
// Forward-looking only: doesn't retroactively delete sessions already
// stored before exclusion.
export const excludedAnonIds = pgTable('excluded_anon_ids', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  anonId: text('anon_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectAnonIdx: uniqueIndex('excluded_anon_ids_project_anon_idx').on(t.projectId, t.anonId),
}));

// One row per session: deterministic digest/narrative (always present once
// swept) + optional LLM intent text. The row doubles as the LLM work queue:
// status/attempts/nextRetryAt drive the worker's SKIP LOCKED claim.
// digestVersion lets the sweeper re-extract old rows when heuristics improve.
export const sessionSummaries = pgTable('session_summaries', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().unique().references(() => sessions.id, { onDelete: 'cascade' }),
  digest: jsonb('digest').notNull(),
  digestVersion: integer('digest_version').notNull(),
  narrative: text('narrative').notNull(),
  insights: jsonb('insights').notNull(),
  // Denormalized from digest.stats.clickCount at sweep time so timeline
  // reads never detoast the digest jsonb per row.
  clicks: integer('clicks').notNull().default(0),
  intentText: text('intent_text'),
  // Whether replay screenshots were attached to the LLM call that produced
  // intentText — drives the "Visual analysis" chip in the UI.
  visualUsed: boolean('visual_used').notNull().default(false),
  status: text('status').notNull().default('pending'), // pending | processing | done | failed
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('session_summaries_status_idx').on(t.status, t.nextRetryAt),
}));

// Admin feature toggles, one row per org (single-org product today).
// Missing row = all defaults (everything enabled). SUMMARIZER_URL unset
// still hard-disables the LLM layer regardless of these flags.
export const appSettings = pgTable('app_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id, { onDelete: 'cascade' }),
  summariesEnabled: boolean('summaries_enabled').notNull().default(true),
  intentEnabled: boolean('intent_enabled').notNull().default(true),
  visualEnabled: boolean('visual_enabled').notNull().default(true),
  profilesEnabled: boolean('profiles_enabled').notNull().default(true),
  clusteringEnabled: boolean('clustering_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Visitor-level profile: a second-pass LLM summary over a visitor's
// per-session intent summaries. visitorKey mirrors the Users page's
// grouping — coalesce(user_id, anon_id). sessionsSummarized records how
// many done session summaries fed the profile; when a visitor gains a
// new summarized session the counts diverge and the sweep re-queues the
// row. Same status/attempts/nextRetryAt queue pattern as session_summaries.
export const userProfiles = pgTable('user_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  visitorKey: text('visitor_key').notNull(),
  profileText: text('profile_text'),
  // Structured research facets extracted by the profile LLM in the same
  // call: { persona, intent, source, experience } — each a one-sentence
  // string. Null for profiles generated before facets existed.
  facets: jsonb('facets'),
  segmentId: uuid('segment_id').references(() => userSegments.id, { onDelete: 'set null' }),
  // 2D PCA projection of the profile embedding, set at clustering time —
  // drives the cluster map without re-embedding on page load.
  mapX: doublePrecision('map_x'),
  mapY: doublePrecision('map_y'),
  sessionsSummarized: integer('sessions_summarized').notNull().default(0),
  status: text('status').notNull().default('pending'), // pending | processing | done | failed
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectVisitorIdx: uniqueIndex('user_profiles_project_visitor_idx').on(t.projectId, t.visitorKey),
  statusIdx: index('user_profiles_status_idx').on(t.status, t.nextRetryAt),
  // Every clustering run deletes segments wholesale; SET NULL needs this
  // to avoid a seq scan per deleted segment.
  segmentIdx: index('user_profiles_segment_idx').on(t.segmentId),
}));

// Behavioral segments discovered by clustering visitor-profile embeddings
// (k-means over MiniLM vectors, k picked by silhouette; named by the
// summarizer LLM). Rebuilt whenever profiles change — each run replaces
// the project's segments wholesale, so rows are cheap and disposable.
export const userSegments = pgTable('user_segments', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Which research dimension this segment belongs to:
  // 'overall' | 'persona' | 'intent' | 'source' | 'experience'.
  dimension: text('dimension').notNull().default('overall'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // Analyst paragraph beyond the one-line description: what unites the
  // group, why it matters, what to do about it.
  analysis: text('analysis').notNull().default(''),
  size: integer('size').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('user_segments_project_idx').on(t.projectId, t.dimension),
}));

// Per-dimension position + segment assignment for each profile — one row
// per (profile, dimension). The 'overall' dimension stays on
// user_profiles.segmentId/mapX/mapY.
export const profileDimensionPoints = pgTable('profile_dimension_points', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => userProfiles.id, { onDelete: 'cascade' }),
  dimension: text('dimension').notNull(),
  segmentId: uuid('segment_id').references(() => userSegments.id, { onDelete: 'set null' }),
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
}, (t) => ({
  profileDimIdx: uniqueIndex('profile_dimension_points_profile_dim_idx').on(t.profileId, t.dimension),
  // Same SET NULL cascade as user_profiles.segment_id.
  segmentIdx: index('profile_dimension_points_segment_idx').on(t.segmentId),
}));

// Batch-level analyst read per dimension ("what Source reveals about
// this cohort"), refreshed on every clustering run.
export const dimensionAnalyses = pgTable('dimension_analyses', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  dimension: text('dimension').notNull(),
  analysis: text('analysis').notNull().default(''),
  builtAt: timestamp('built_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectDimIdx: uniqueIndex('dimension_analyses_project_dim_idx').on(t.projectId, t.dimension),
}));

// Pre-aggregated hourly session metrics per project, built by queued,
// idempotent jobs (recompute-the-hour from raw rows). The unbounded
// 'all' timeline range reads these instead of scanning every session;
// hot ranges (24h/7d/30d) stay raw for exactness. A zero-session hour
// still gets a row — that's how read-side coverage is proven.
export const timelineRollups = pgTable('timeline_rollups', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
  sessions: integer('sessions').notNull().default(0),
  engaged: integer('engaged').notNull().default(0),
  engagedNew: integer('engaged_new').notNull().default(0),
  frustrated: integer('frustrated').notNull().default(0),
  // Sessions that are their visitor's first ever — summing these over a
  // window that starts at the project's first session equals distinct
  // new visitors in that window.
  newVisitorSessions: integer('new_visitor_sessions').notNull().default(0),
  durationSumMs: bigint('duration_sum_ms', { mode: 'number' }).notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  tagged: integer('tagged').notNull().default(0),
  bySource: jsonb('by_source').notNull().default({}),
  clicksByDevice: jsonb('clicks_by_device').notNull().default({}),
  frictionByKind: jsonb('friction_by_kind').notNull().default({}),
  byTag: jsonb('by_tag').notNull().default({}),
  byDevice: jsonb('by_device').notNull().default({}),
  byBrowser: jsonb('by_browser').notNull().default({}),
  byCountry: jsonb('by_country').notNull().default({}),
  byReferrerHost: jsonb('by_referrer_host').notNull().default({}),
  byEntryPath: jsonb('by_entry_path').notNull().default({}),
  // {path: {n, bad}} — powers the Overview's worst-friction-entry callout.
  byEntryFriction: jsonb('by_entry_friction').notNull().default({}),
  builtAt: timestamp('built_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectHourIdx: uniqueIndex('timeline_rollups_project_hour_idx').on(t.projectId, t.hourStart),
}));

// Researcher conversations, one per (admin, project, conversation). The
// title comes from the first question (trimmed to a few words) and
// powers the History view; lastMessageAt orders it.
export const researcherThreads = pgTable('researcher_threads', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userProjectIdx: index('researcher_threads_user_project_idx').on(t.userId, t.projectId, t.lastMessageAt),
}));

// One row per turn half. Assistant rows carry the full render payload
// (blocks, footprints, citations, caveat, follow-ups) as jsonb so History
// recall replays instantly without re-running anything.
export const researcherMessages = pgTable('researcher_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => researcherThreads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  threadIdx: index('researcher_messages_thread_idx').on(t.threadId, t.createdAt),
}));

// Cached analyst read of the timeline window per range (24h / 7d / 30d),
// refreshed by a background cycle — never generated at page-view time.
export const timelineAnalyses = pgTable('timeline_analyses', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  rangeKey: text('range_key').notNull(),
  analysis: text('analysis').notNull().default(''),
  patterns: jsonb('patterns'),
  builtAt: timestamp('built_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectRangeIdx: uniqueIndex('timeline_analyses_project_range_idx').on(t.projectId, t.rangeKey),
}));

