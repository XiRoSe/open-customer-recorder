import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, sql } from 'drizzle-orm';
import { verifyIngestToken } from '@/lib/ingest-token';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MAX_SESSION_DURATION_MS, splitAtCap, cappedDurationMs } from '@/lib/session-cap';

const MAX_BYTES_PER_SESSION = 10 * 1024 * 1024; // 10 MB
// Same cap as the v2 ingest path. Legacy endpoint kept around for any cached
// old tracker.js bundles still in the wild — must enforce the cap here too so
// stale clients can't outlive the limit.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-recorder-token, content-encoding',
};

type EventLine = { raw: string; ts: number | null };
function parseEventLines(plainText: string): EventLine[] {
  const out: EventLine[] = [];
  for (const raw of plainText.split('\n')) {
    if (!raw.trim()) continue;
    let ts: number | null = null;
    try {
      const p = JSON.parse(raw) as { timestamp?: unknown };
      if (typeof p.timestamp === 'number' && p.timestamp > 0) ts = p.timestamp;
    } catch {}
    out.push({ raw, ts });
  }
  return out;
}

export async function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tokenHeader = req.headers.get('x-recorder-token');
  if (!tokenHeader) return NextResponse.json({ error: 'missing token' }, { status: 401, headers: CORS });
  let payload;
  try {
    payload = await verifyIngestToken(tokenHeader);
  } catch {
    return NextResponse.json({ error: 'bad token' }, { status: 401, headers: CORS });
  }
  if (payload.sessionId !== id) {
    return NextResponse.json({ error: 'token session mismatch' }, { status: 403, headers: CORS });
  }
  // Client may abort mid-upload on page unload. Treat that as a no-op
  // (the recorder will retry on the next flush / keepalive POST) instead
  // of letting Next surface it as an uncaught 500 in the logs.
  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await req.arrayBuffer());
  } catch {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (rawBody.length === 0) return new Response(null, { status: 204, headers: CORS });

  // Body may be gzipped (`Content-Encoding: gzip` from regular flush) OR
  // plain NDJSON (from the unload-flush path which can't easily gzip).
  // Parse to NDJSON first so we can read per-event timestamps and apply
  // the video-length cap; re-gzip after filtering.
  const isGzipped = req.headers.get('content-encoding') === 'gzip';
  let plainText: string;
  try {
    plainText = (isGzipped ? gunzipSync(rawBody) : rawBody).toString('utf8');
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS });
  }
  const events = parseEventLines(plainText);

  const [existing] = await db.select({
    blobBytes: schema.sessions.blobBytes,
    startedAt: schema.sessions.startedAt,
    endedAt: schema.sessions.endedAt,
  }).from(schema.sessions).where(eq(schema.sessions.id, id));
  if (!existing) return NextResponse.json({ error: 'unknown session' }, { status: 404, headers: CORS });

  const startedAtMs = existing.startedAt.getTime();
  const cutoffMs = startedAtMs + MAX_SESSION_DURATION_MS;
  const { kept, droppedAny } = splitAtCap(events, startedAtMs);

  if (existing.endedAt && existing.endedAt.getTime() >= cutoffMs - 1) {
    return new Response(null, { status: 410, headers: CORS });
  }
  if (events.length > 0 && kept.length === 0) {
    await db.update(schema.sessions).set({
      endedAt: new Date(cutoffMs),
      durationMs: MAX_SESSION_DURATION_MS,
    }).where(eq(schema.sessions.id, id));
    return new Response(null, { status: 410, headers: CORS });
  }

  let bodyToStore: Buffer = Buffer.alloc(0);
  if (kept.length > 0) {
    const ndjson = Buffer.from(kept.map((e) => e.raw).join('\n') + '\n');
    bodyToStore = gzipSync(ndjson);
  }

  if ((existing.blobBytes + bodyToStore.length) > MAX_BYTES_PER_SESSION) {
    return NextResponse.json({ error: 'session too large' }, { status: 413, headers: CORS });
  }

  const keptTimestamps = kept.map((e) => e.ts).filter((t): t is number => t != null);
  const batchMaxTs = keptTimestamps.length ? Math.max(...keptTimestamps) : startedAtMs;
  const cappedDuration = cappedDurationMs(startedAtMs, batchMaxTs);

  const update: Record<string, unknown> = {
    lastActivityAt: new Date(),
    durationMs: sql`LEAST(GREATEST(COALESCE(${schema.sessions.durationMs}, 0), ${cappedDuration}), ${MAX_SESSION_DURATION_MS})`,
  };
  if (bodyToStore.length > 0) {
    update.blobData = sql`${schema.sessions.blobData} || ${bodyToStore}::bytea`;
    update.blobBytes = sql`${schema.sessions.blobBytes} + ${bodyToStore.length}`;
    update.eventCount = sql`${schema.sessions.eventCount} + ${kept.length}`;
  }
  if (droppedAny) update.endedAt = new Date(Math.min(batchMaxTs, cutoffMs));

  await db.update(schema.sessions).set(update).where(eq(schema.sessions.id, id));

  if (droppedAny) return new Response(null, { status: 410, headers: CORS });
  return new Response(null, { status: 204, headers: CORS });
}
