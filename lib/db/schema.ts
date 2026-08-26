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
  // Denormalized from digest.stats.clickCount at sweep time so aggregate
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
// Missing row = all defaults (everything enabled). LLM_SERVICE_URL unset
// still hard-disables the LLM layer regardless of these flags.
export const appSettings = pgTable('app_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id, { onDelete: 'cascade' }),
  summariesEnabled: boolean('summaries_enabled').notNull().default(true),
  intentEnabled: boolean('intent_enabled').notNull().default(true),
  visualEnabled: boolean('visual_enabled').notNull().default(true),
  profilesEnabled: boolean('profiles_enabled').notNull().default(true),
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
  sessionsSummarized: integer('sessions_summarized').notNull().default(0),
  status: text('status').notNull().default('pending'), // pending | processing | done | failed
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectVisitorIdx: uniqueIndex('user_profiles_project_visitor_idx').on(t.projectId, t.visitorKey),
  statusIdx: index('user_profiles_status_idx').on(t.status, t.nextRetryAt),
}));
