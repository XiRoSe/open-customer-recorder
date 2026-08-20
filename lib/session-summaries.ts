import { gunzipSync } from 'node:zlib';
import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { DIGEST_VERSION, extractDigest, renderNarrative } from './session-digest';
import { getAppSettings } from './app-settings';

export const SUMMARY_BATCH = 50;
// A session with no end beacon counts as over after 6 min of silence:
// the tracker's resume window is 5 min (SESSION_TTL_MS), so after that
// the browser can never continue this session — +1 min slack for clock
// skew and in-flight batches. Keep in lockstep with the State column's
// SQL interval in app/(admin)/projects/[id]/sessions/page.tsx.
const ABANDONED_AFTER_MS = 6 * 60 * 1000;

/** Digest every "over" session that has no summary row yet (or a stale
 * digestVersion). Never throws for a single bad session — that session
 * gets a failed row and the sweep moves on. Returns rows written. */
export async function runSummarySweepOnce(): Promise<number> {
  const { summariesEnabled } = await getAppSettings();
  if (!summariesEnabled) return 0;
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
  const candidates = await db
    .select({ id: schema.sessions.id, blobData: schema.sessions.blobData })
    .from(schema.sessions)
    .leftJoin(schema.sessionSummaries, eq(schema.sessionSummaries.sessionId, schema.sessions.id))
    .where(and(
      gt(schema.sessions.eventCount, 0),
      or(sql`${schema.sessions.endedAt} IS NOT NULL`, lt(schema.sessions.lastActivityAt, cutoff)),
      or(isNull(schema.sessionSummaries.id), ne(schema.sessionSummaries.digestVersion, DIGEST_VERSION)),
    ))
    .limit(SUMMARY_BATCH);

  let written = 0;
  for (const c of candidates) {
    let values: typeof schema.sessionSummaries.$inferInsert;
    try {
      const ndjson = gunzipSync(c.blobData).toString('utf8');
      const digest = extractDigest(ndjson);
      values = {
        sessionId: c.id, digest, digestVersion: DIGEST_VERSION,
        narrative: renderNarrative(digest), insights: digest.insights,
        status: 'pending', attempts: 0, nextRetryAt: null,
      };
    } catch (e) {
      values = {
        sessionId: c.id, digest: {}, digestVersion: DIGEST_VERSION,
        narrative: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`,
        insights: [], status: 'failed',
      };
    }
    await db.insert(schema.sessionSummaries).values(values)
      .onConflictDoUpdate({
        target: schema.sessionSummaries.sessionId,
        set: { ...values, updatedAt: new Date() },
      });
    written++;
  }
  return written;
}

export interface SessionSummaryPreview { intentText: string | null; narrative: string; status: string }

/** Summary texts for the sessions list column. */
export async function summariesForSessions(ids: string[]): Promise<Map<string, SessionSummaryPreview>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      sessionId: schema.sessionSummaries.sessionId,
      intentText: schema.sessionSummaries.intentText,
      narrative: schema.sessionSummaries.narrative,
      status: schema.sessionSummaries.status,
    })
    .from(schema.sessionSummaries)
    .where(inArray(schema.sessionSummaries.sessionId, ids));
  return new Map(rows.map((r) => [r.sessionId, { intentText: r.intentText, narrative: r.narrative, status: r.status }]));
}
