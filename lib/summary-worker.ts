import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { pickFrameMoments, renderSessionFrames } from './session-frames';
import type { SessionDigest } from './session-digest';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

// Keep byte-identical to scripts/export-training-data.mjs — fine-tuning
// data must match the inference prompt.
const SYSTEM_PROMPT = `You analyze a website visitor's session digest (JSON: steps the visitor took, frustration signals, timing stats). Screenshots of key replay moments may be attached - mention visible layout or content problems only if they are clearly relevant.
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

/** Drain all due pending rows sequentially (keeps the sleeping summarizer
 * service awake for one burst). Returns rows completed successfully. */
export async function drainSummaryQueue(
  fetchFn: typeof fetch = fetch,
  frameRenderer: FrameRenderer = renderSessionFrames,
): Promise<number> {
  const baseUrl = process.env.SUMMARIZER_URL;
  if (!baseUrl) return 0;
  const settings = await getAppSettings();
  if (!settings.intentEnabled) return 0;
  const modelLabel = process.env.SUMMARIZER_MODEL_LABEL || 'unknown';
  let done = 0;
  for (;;) {
    const row = await claimOne();
    if (!row) break;
    try {
      const content: ContentPart[] = [{ type: 'text', text: JSON.stringify(row.digest) }];
      if (settings.visualEnabled) {
        const frames = await framesFor(row.session_id, row.digest as SessionDigest, frameRenderer);
        for (const b64 of frames) {
          content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
        }
      }
      const intentText = await callSummarizer(baseUrl, content, fetchFn);
      await db.execute(sql`
        UPDATE ${schema.sessionSummaries}
        SET status = 'done', intent_text = ${intentText}, model = ${modelLabel}, updated_at = now()
        WHERE id = ${row.id}
      `);
      done++;
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
        WHERE id = ${row.id}
      `);
      console.warn('[summary-worker] attempt failed', row.id, e instanceof Error ? e.message : e);
      if (failed) continue;
      break; // transient failure — stop the burst, retry next cycle
    }
  }
  return done;
}

/** Crash recovery: a worker that died mid-call leaves a 'processing' row.
 * Anything processing >10 min is orphaned — back to pending. */
export async function resetStuckProcessing(): Promise<void> {
  await db.execute(sql`
    UPDATE ${schema.sessionSummaries} SET status = 'pending', updated_at = now()
    WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'
  `);
}
