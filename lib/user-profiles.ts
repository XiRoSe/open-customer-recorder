// Visitor-level profiles: hierarchical summarization. The per-session
// intent summaries already exist; a profile is a second, text-only LLM
// pass over a visitor's most recent ones. Regenerated automatically when
// the visitor gains a new summarized session (counts diverge → re-queued).
import { sql, inArray, and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';

export const PROFILE_MIN_SESSIONS = 2;   // 1 session would just parrot its summary
export const PROFILE_MAX_INPUT = 15;     // newest summaries fed to the model
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const SWEEP_BATCH = 25;

const PROFILE_SYSTEM_PROMPT = `You build a profile of one website visitor from AI summaries of their recorded sessions, listed newest first.
Write 3-5 plain sentences: who this visitor appears to be, what they are trying to achieve across visits, recurring friction they hit, and whether their engagement is growing or fading.
Only state what the data supports. No markdown, no preamble, no bullet points.`;

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

interface SummaryLine extends Record<string, unknown> { started_at: string; duration_ms: number | null; intent_text: string; total: number }

async function buildProfileInput(projectId: string, visitorKey: string): Promise<string | null> {
  const res = await db.execute<SummaryLine>(sql`
    SELECT s.started_at, s.duration_ms, ss.intent_text, count(*) OVER ()::int AS total
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
  const lines = rows.map((r) => `- ${String(r.started_at).slice(0, 10)} (${secs(r.duration_ms)}): ${r.intent_text}`);
  const header = total > rows.length
    ? `Visitor with ${total} summarized sessions; the ${rows.length} most recent:`
    : `Visitor with ${total} summarized sessions:`;
  return `${header}\n${lines.join('\n')}`;
}

/** Drain due pending profile rows. Text-only LLM calls — no frames. */
export async function drainUserProfiles(fetchFn: typeof fetch = fetch): Promise<number> {
  const baseUrl = process.env.SUMMARIZER_URL;
  if (!baseUrl) return 0;
  const settings = await getAppSettings();
  if (!settings.profilesEnabled || !settings.intentEnabled) return 0;
  let done = 0;
  for (;;) {
    const row = await claimOne();
    if (!row) break;
    try {
      const input = await buildProfileInput(row.project_id, row.visitor_key);
      if (!input) {
        // Below threshold (e.g. summaries were deleted) — drop the row.
        await db.execute(sql`DELETE FROM ${schema.userProfiles} WHERE id = ${row.id}`);
        continue;
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
      await db.execute(sql`
        UPDATE ${schema.userProfiles}
        SET status = 'done', profile_text = ${profileText}, updated_at = now()
        WHERE id = ${row.id}
      `);
      done++;
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
      if (failed) continue;
      break;
    }
  }
  return done;
}

export interface VisitorProfile { profileText: string | null; status: string; sessionsSummarized: number }

/** Profiles for the Users page, keyed by visitorKey. */
export async function profilesForVisitors(projectId: string, keys: string[]): Promise<Map<string, VisitorProfile>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select({
    visitorKey: schema.userProfiles.visitorKey,
    profileText: schema.userProfiles.profileText,
    status: schema.userProfiles.status,
    sessionsSummarized: schema.userProfiles.sessionsSummarized,
  }).from(schema.userProfiles)
    .where(and(eq(schema.userProfiles.projectId, projectId), inArray(schema.userProfiles.visitorKey, keys)));
  return new Map(rows.map((r) => [r.visitorKey, { profileText: r.profileText, status: r.status, sessionsSummarized: r.sessionsSummarized }]));
}
