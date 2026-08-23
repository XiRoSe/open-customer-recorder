import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { pickFrameMoments, renderSessionFrames } from './session-frames';
import { compactDigest, type SessionDigest } from './session-digest';
import { llmBaseUrl, llmModelLabel } from './llm-service';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

// Keep byte-identical to scripts/export-training-data.mjs — fine-tuning
// data must match the inference prompt.
const SYSTEM_PROMPT = `You analyze a website visitor's session activity log (steps the visitor took, frustration signals, timing stats). Screenshots of key replay moments may be attached - mention visible layout or content problems only if they are clearly relevant.
Write 2-3 plain sentences: what the visitor was likely trying to do, and any friction they hit.
Only state what the data supports. No markdown, no preamble, no bullet points.`;

interface ClaimedRow extends Record<string, unknown> { id: string; session_id: string; digest: unknown; attempts: number }

/** Claim the NEWEST due pending row. Fresh sessions get their intent
 * summary right away; the historical backfill fills in behind them.
 * SKIP LOCKED keeps concurrent app replicas from double-processing.
 * Returns null when the queue is drained. */
async function claimOne(): Promise<ClaimedRow | null> {
  const res = await db.execute<ClaimedRow>(sql`
    UPDATE ${schema.sessionSummaries} SET status = 'processing', updated_at = now()
    WHERE id = (
      SELECT id FROM ${schema.sessionSummaries}
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at < now())
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, session_id, digest, attempts
  `);
  const rows: ClaimedRow[] = Array.isArray(res) ? res : (res as unknown as { rows: ClaimedRow[] }).rows ?? [];
  return rows[0] ?? null;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

async function callSummarizer(baseUrl: string, content: ContentPart[], fetchFn: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error(`summarizer ${res.status}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('summarizer returned empty content');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export type FrameRenderer = (ndjson: string, momentsMs: number[]) => Promise<string[]>;

/** Best-effort frames for the vision model. Any failure ⇒ no frames —
 * a summary must never be blocked by Chromium. */
async function framesFor(sessionId: string, digest: SessionDigest, render: FrameRenderer): Promise<string[]> {
  try {
    const [row] = await db.select({ blobData: schema.sessions.blobData })
      .from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    if (!row?.blobData?.length) return [];
    const moments = pickFrameMoments(digest);
    if (moments.length === 0) return [];
    return await render(gunzipSync(row.blobData).toString('utf8'), moments);
  } catch (e) {
    console.warn('[summary-worker] frame render failed (continuing text-only)', sessionId, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Claim and process exactly one due pending row. 'empty' = queue is
 * drained; 'error' = transient failure (row got backoff, caller should
 * pause the burst). Called by the legacy drain loop AND BullMQ workers. */
export async function processNextSummary(
  fetchFn: typeof fetch = fetch,
  frameRenderer: FrameRenderer = renderSessionFrames,
): Promise<'done' | 'skip' | 'empty' | 'error' | 'disabled'> {
  const baseUrl = llmBaseUrl();
  if (!baseUrl) return 'disabled';
  const settings = await getAppSettings();
  if (!settings.intentEnabled) return 'disabled';
  const row = await claimOne();
  if (!row) return 'empty';
  try {
    const content: ContentPart[] = [{ type: 'text', text: compactDigest(row.digest) }];
    let visualUsed = false;
    if (settings.visualEnabled) {
      const frames = await framesFor(row.session_id, row.digest as SessionDigest, frameRenderer);
      for (const b64 of frames) {
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
      }
      visualUsed = frames.length > 0;
    }
    const intentText = await callSummarizer(baseUrl, content, fetchFn);
    await db.execute(sql`
      UPDATE ${schema.sessionSummaries}
      SET status = 'done', intent_text = ${intentText}, model = ${llmModelLabel()},
          visual_used = ${visualUsed}, updated_at = now()
      WHERE id = ${row.id} AND status = 'processing'
    `);
    return 'done';
  } catch (e) {
    const attempts = row.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    // Exponential backoff: 2, 4, 8 minutes.
    const retryAt = failed ? null : new Date(Date.now() + 2 ** attempts * 60_000).toISOString();
    await db.execute(sql`
      UPDATE ${schema.sessionSummaries}
      SET status = ${failed ? 'failed' : 'pending'}, attempts = ${attempts},
          next_retry_at = ${retryAt}::timestamptz,
          updated_at = now()
      WHERE id = ${row.id} AND status = 'processing'
    `);
    console.warn('[summary-worker] attempt failed', row.id, e instanceof Error ? e.message : e);
    return failed ? 'skip' : 'error'; // terminal failure doesn't pause the burst
  }
}

/** Drain all due pending rows sequentially (keeps the sleeping LLM
 * service awake for one burst). Returns rows completed successfully. */
export async function drainSummaryQueue(
  fetchFn: typeof fetch = fetch,
  frameRenderer: FrameRenderer = renderSessionFrames,
): Promise<number> {
  let done = 0;
  for (;;) {
    const r = await processNextSummary(fetchFn, frameRenderer);
    if (r === 'done') { done++; continue; }
    if (r === 'skip') continue;
    break; // empty, disabled, or transient error — stop the burst
  }
  return done;
}

/** How many due pending rows exist, with age — the queue reconciler
 * turns these into deduped job signals. */
export async function duePendingSummaries(limit = 500): Promise<{ id: string; ageMinutes: number }[]> {
  const res = await db.execute<{ id: string; age_minutes: number }>(sql`
    SELECT id, EXTRACT(EPOCH FROM (now() - created_at))::int / 60 AS age_minutes
    FROM ${schema.sessionSummaries}
    WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at < now())
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(res) ? res : (res as unknown as { rows: { id: string; age_minutes: number }[] }).rows ?? [];
  return rows.map((r) => ({ id: r.id, ageMinutes: Number(r.age_minutes) }));
}

/** Crash recovery: a worker that died mid-call leaves a 'processing' row.
 * Anything processing >10 min is orphaned — back to pending. */
export async function resetStuckProcessing(): Promise<void> {
  await db.execute(sql`
    UPDATE ${schema.sessionSummaries} SET status = 'pending', updated_at = now()
    WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'
  `);
}
