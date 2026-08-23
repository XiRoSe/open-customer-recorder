// Visitor-level profiles: hierarchical summarization. The per-session
// intent summaries already exist; a profile is a second, text-only LLM
// pass over a visitor's most recent ones. Regenerated automatically when
// the visitor gains a new summarized session (counts diverge → re-queued).
import { sql, inArray, and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { llmBaseUrl } from './llm-service';

export const PROFILE_MIN_SESSIONS = 2;   // 1 session would just parrot its summary
export const PROFILE_MAX_INPUT = 15;     // newest summaries fed to the model
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const SWEEP_BATCH = 25;

const PROFILE_SYSTEM_PROMPT = `You are an expert researcher of website visitors and buyers. From the AI summaries of one visitor's recorded sessions (newest first, with entry pages and referrers), write exactly four lines:
Persona: <who this visitor appears to be - role, sophistication, context. One sentence.>
Intent: <what they are trying to achieve across visits. One sentence.>
Source: <where they come from and why - referrers, entry pages, campaigns; if unknown, what the entry pages suggest. One sentence.>
Experience: <friction they hit and whether engagement is growing or fading. One sentence.>
Only state what the data supports. No markdown, no extra lines.`;

export interface ProfileFacets { persona?: string; intent?: string; source?: string; experience?: string }

export function parseFacets(text: string): ProfileFacets | null {
  const grab = (label: string) => new RegExp(`^${label}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim();
  const facets: ProfileFacets = {};
  for (const key of ['persona', 'intent', 'source', 'experience'] as const) {
    const v = grab(key[0].toUpperCase() + key.slice(1));
    if (v) facets[key] = v.slice(0, 400);
  }
  return Object.keys(facets).length >= 2 ? facets : null;
}

interface VisitorCount extends Record<string, unknown> { project_id: string; visitor_key: string; done_count: number }

/** Queue a profile (re)build for every visitor whose count of summarized
 * sessions no longer matches their profile row. Returns rows queued. */
export async function sweepUserProfilesOnce(): Promise<number> {
  const settings = await getAppSettings();
  if (!settings.profilesEnabled || !settings.intentEnabled) return 0;
  const res = await db.execute<VisitorCount>(sql`
    SELECT s.project_id, coalesce(s.user_id, s.anon_id) AS visitor_key, count(*)::int AS done_count
    FROM ${schema.sessions} s
    JOIN ${schema.sessionSummaries} ss ON ss.session_id = s.id
    WHERE ss.status = 'done' AND ss.intent_text IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) >= ${PROFILE_MIN_SESSIONS}
  `);
  const visitors: VisitorCount[] = Array.isArray(res) ? res : (res as unknown as { rows: VisitorCount[] }).rows ?? [];
  let queued = 0;
  for (const v of visitors) {
    if (queued >= SWEEP_BATCH) break;
    const [existing] = await db.select({ sessionsSummarized: schema.userProfiles.sessionsSummarized, status: schema.userProfiles.status })
      .from(schema.userProfiles)
      .where(and(eq(schema.userProfiles.projectId, v.project_id), eq(schema.userProfiles.visitorKey, v.visitor_key)))
      .limit(1);
    if (existing && existing.sessionsSummarized === v.done_count && existing.status !== 'failed') continue;
    await db.insert(schema.userProfiles)
      .values({ projectId: v.project_id, visitorKey: v.visitor_key, sessionsSummarized: v.done_count, status: 'pending', attempts: 0, nextRetryAt: null })
      .onConflictDoUpdate({
        target: [schema.userProfiles.projectId, schema.userProfiles.visitorKey],
        set: { sessionsSummarized: v.done_count, status: 'pending', attempts: 0, nextRetryAt: null, updatedAt: new Date() },
      });
    queued++;
  }
  return queued;
}

interface ClaimedProfile extends Record<string, unknown> { id: string; project_id: string; visitor_key: string; attempts: number }

async function claimOne(): Promise<ClaimedProfile | null> {
  const res = await db.execute<ClaimedProfile>(sql`
    UPDATE ${schema.userProfiles} SET status = 'processing', updated_at = now()
    WHERE id = (
      SELECT id FROM ${schema.userProfiles}
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at < now())
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, project_id, visitor_key, attempts
  `);
  const rows: ClaimedProfile[] = Array.isArray(res) ? res : (res as unknown as { rows: ClaimedProfile[] }).rows ?? [];
  return rows[0] ?? null;
}

interface SummaryLine extends Record<string, unknown> { started_at: string; duration_ms: number | null; intent_text: string; page_url: string | null; referrer: string | null; total: number }

async function buildProfileInput(projectId: string, visitorKey: string): Promise<string | null> {
  const res = await db.execute<SummaryLine>(sql`
    SELECT s.started_at, s.duration_ms, s.page_url, s.referrer, ss.intent_text, count(*) OVER ()::int AS total
    FROM ${schema.sessions} s
    JOIN ${schema.sessionSummaries} ss ON ss.session_id = s.id
    WHERE s.project_id = ${projectId}
      AND coalesce(s.user_id, s.anon_id) = ${visitorKey}
      AND ss.status = 'done' AND ss.intent_text IS NOT NULL
    ORDER BY s.started_at DESC
    LIMIT ${PROFILE_MAX_INPUT}
  `);
  const rows: SummaryLine[] = Array.isArray(res) ? res : (res as unknown as { rows: SummaryLine[] }).rows ?? [];
  if (rows.length < PROFILE_MIN_SESSIONS) return null;
  const total = rows[0].total;
  const secs = (ms: number | null) => `${Math.round((ms ?? 0) / 1000)}s`;
  const pathOf = (url: string | null) => { if (!url) return null; try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
  const lines = rows.map((r) => {
    const ctx = [pathOf(r.page_url) ? `entry ${pathOf(r.page_url)}` : null, r.referrer ? `from ${r.referrer}` : null].filter(Boolean).join(', ');
    return `- ${String(r.started_at).slice(0, 10)} (${secs(r.duration_ms)}${ctx ? `, ${ctx}` : ''}): ${r.intent_text}`;
  });
  const header = total > rows.length
    ? `Visitor with ${total} summarized sessions; the ${rows.length} most recent:`
    : `Visitor with ${total} summarized sessions:`;
  return `${header}\n${lines.join('\n')}`;
}

/** Claim and process exactly one due pending profile. 'empty' = drained;
 * 'error' = transient failure (row got backoff, caller should pause).
 * Called by the legacy drain loop AND BullMQ workers. */
export async function processNextProfile(fetchFn: typeof fetch = fetch): Promise<'done' | 'skip' | 'empty' | 'error' | 'disabled'> {
  const baseUrl = llmBaseUrl();
  if (!baseUrl) return 'disabled';
  const settings = await getAppSettings();
  if (!settings.profilesEnabled || !settings.intentEnabled) return 'disabled';
  const row = await claimOne();
  if (!row) return 'empty';
  {
    try {
      const input = await buildProfileInput(row.project_id, row.visitor_key);
      if (!input) {
        // Below threshold (e.g. summaries were deleted) — drop the row.
        await db.execute(sql`DELETE FROM ${schema.userProfiles} WHERE id = ${row.id}`);
        return 'skip';
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let profileText: string;
      try {
        const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            messages: [
              { role: 'system', content: PROFILE_SYSTEM_PROMPT },
              { role: 'user', content: input },
            ],
            max_tokens: 220,
            temperature: 0.3,
          }),
        });
        if (!res.ok) throw new Error(`summarizer ${res.status}`);
        const json = await res.json() as { choices?: { message?: { content?: string } }[] };
        const text = json.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('summarizer returned empty content');
        profileText = text;
      } finally {
        clearTimeout(timer);
      }
      const facets = parseFacets(profileText);
      await db.execute(sql`
        UPDATE ${schema.userProfiles}
        SET status = 'done', profile_text = ${profileText},
            facets = ${facets ? JSON.stringify(facets) : null}::jsonb, updated_at = now()
        WHERE id = ${row.id}
      `);
      return 'done';
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const retryAt = failed ? null : new Date(Date.now() + 2 ** attempts * 60_000).toISOString();
      await db.execute(sql`
        UPDATE ${schema.userProfiles}
        SET status = ${failed ? 'failed' : 'pending'}, attempts = ${attempts},
            next_retry_at = ${retryAt}::timestamptz, updated_at = now()
        WHERE id = ${row.id}
      `);
      console.warn('[user-profiles] attempt failed', row.id, e instanceof Error ? e.message : e);
      return failed ? 'skip' : 'error';
    }
  }
}

/** Drain due pending profile rows. Text-only LLM calls — no frames. */
export async function drainUserProfiles(fetchFn: typeof fetch = fetch): Promise<number> {
  let done = 0;
  for (;;) {
    const r = await processNextProfile(fetchFn);
    if (r === 'done') { done++; continue; }
    if (r === 'skip') continue;
    break;
  }
  return done;
}

/** Crash recovery: a worker that died mid-call leaves a 'processing'
 * profile row that would otherwise never be claimed again. Anything
 * processing >10 min is orphaned — back to pending. */
export async function resetStuckProfiles(): Promise<void> {
  await db.execute(sql`
    UPDATE ${schema.userProfiles} SET status = 'pending', updated_at = now()
    WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'
  `);
}

/** Due pending profiles with age, for the queue reconciler. */
export async function duePendingProfiles(limit = 200): Promise<{ id: string; ageMinutes: number }[]> {
  const res = await db.execute<{ id: string; age_minutes: number }>(sql`
    SELECT id, EXTRACT(EPOCH FROM (now() - updated_at))::int / 60 AS age_minutes
    FROM ${schema.userProfiles}
    WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at < now())
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(res) ? res : (res as unknown as { rows: { id: string; age_minutes: number }[] }).rows ?? [];
  return rows.map((r) => ({ id: r.id, ageMinutes: Number(r.age_minutes) }));
}

export interface VisitorProfile { profileText: string | null; status: string; sessionsSummarized: number; segmentId: string | null }

/** Profiles for the Users page, keyed by visitorKey. */
export async function profilesForVisitors(projectId: string, keys: string[]): Promise<Map<string, VisitorProfile>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select({
    visitorKey: schema.userProfiles.visitorKey,
    profileText: schema.userProfiles.profileText,
    status: schema.userProfiles.status,
    sessionsSummarized: schema.userProfiles.sessionsSummarized,
    segmentId: schema.userProfiles.segmentId,
  }).from(schema.userProfiles)
    .where(and(eq(schema.userProfiles.projectId, projectId), inArray(schema.userProfiles.visitorKey, keys)));
  return new Map(rows.map((r) => [r.visitorKey, { profileText: r.profileText, status: r.status, sessionsSummarized: r.sessionsSummarized, segmentId: r.segmentId }]));
}
