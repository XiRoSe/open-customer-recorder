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
  // Metadata only — blobs are fetched one row at a time below, so a
  // batch of 50 never holds 50 decompressed replays in memory at once.
  const candidates = await db
    .select({
      id: schema.sessions.id,
      projectId: schema.sessions.projectId,
      startedAt: schema.sessions.startedAt,
      pageUrl: schema.sessions.pageUrl,
      referrer: schema.sessions.referrer,
      country: schema.sessions.country,
      browser: schema.sessions.browser,
      os: schema.sessions.os,
    })
    .from(schema.sessions)
    .leftJoin(schema.sessionSummaries, eq(schema.sessionSummaries.sessionId, schema.sessions.id))
    .where(and(
      gt(schema.sessions.eventCount, 0),
      or(sql`${schema.sessions.endedAt} IS NOT NULL`, lt(schema.sessions.lastActivityAt, cutoff)),
      or(isNull(schema.sessionSummaries.id), ne(schema.sessionSummaries.digestVersion, DIGEST_VERSION)),
    ))
    .limit(SUMMARY_BATCH);

  // Hours whose rollups this sweep invalidates: a digest landing for a
  // session that started >2h ago (late end, or a digest-version
  // re-extraction) changes history the rollup refresher never revisits.
  const staleHours = new Map<string, Set<number>>();
  const HOUR_MS = 3600_000;
  const lateCutoff = Date.now() - 2 * HOUR_MS;

  let written = 0;
  for (const c of candidates) {
    let values: typeof schema.sessionSummaries.$inferInsert;
    try {
      const [blobRow] = await db.select({ blobData: schema.sessions.blobData })
        .from(schema.sessions).where(eq(schema.sessions.id, c.id)).limit(1);
      const ndjson = gunzipSync(blobRow.blobData).toString('utf8');
      const digest = extractDigest(ndjson);
      digest.context = {
        ...(c.pageUrl ? { entryUrl: c.pageUrl } : {}),
        ...(c.referrer ? { referrer: c.referrer } : {}),
        ...(c.country ? { country: c.country } : {}),
        ...(c.browser ? { browser: c.browser } : {}),
        ...(c.os ? { os: c.os } : {}),
      };
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
    // A digest-version bump re-extracts old rows; rows that already have
    // an AI summary keep it (and their status) instead of re-queuing an
    // LLM call for the whole history. Rows currently 'processing' also
    // keep their status — re-pending one mid-LLM-call would let a second
    // worker claim it and double-spend.
    const { status: newStatus, ...rest } = values;
    await db.insert(schema.sessionSummaries).values(values)
      .onConflictDoUpdate({
        target: schema.sessionSummaries.sessionId,
        set: {
          ...rest,
          status: sql`CASE WHEN ${schema.sessionSummaries.intentText} IS NULL AND ${schema.sessionSummaries.status} <> 'processing' THEN ${newStatus} ELSE ${schema.sessionSummaries.status} END`,
          updatedAt: new Date(),
        },
      });
    written++;
    if (c.startedAt.getTime() < lateCutoff) {
      const hours = staleHours.get(c.projectId) ?? new Set<number>();
      hours.add(Math.floor(c.startedAt.getTime() / HOUR_MS) * HOUR_MS);
      staleHours.set(c.projectId, hours);
    }
  }

  if (staleHours.size > 0) {
    const { invalidateRollups } = await import('./rollups');
    for (const [projectId, hours] of staleHours) {
      await invalidateRollups(projectId, [...hours]).catch((e) =>
        console.warn('[summaries] rollup invalidation failed', projectId, e instanceof Error ? e.message : e));
    }
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
