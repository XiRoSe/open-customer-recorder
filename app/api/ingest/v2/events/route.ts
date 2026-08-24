/**
 * Single ingest endpoint. Replaces the old 3-step dance
 * (POST /start → POST /events → POST /end) with one upsert-style POST
 * that survives unload via keepalive.
 *
 * Request:
 *   POST /api/ingest/v2/events?k=<projectKey>&sid=<clientUuid>&a=<anonId>&u=<pageUrl>
 *   Headers:
 *     content-encoding: gzip   (optional; body may be plain ndjson)
 *     content-type: application/x-ndjson
 *     x-ps-end: 1              (optional; final POST of a session, sets ended_at)
 *   Body: ndjson of rrweb events (optionally gzipped)
 *
 * x-ps-end replaced the pre-rebrand x-mega-end header. The old name is
 * still honored (gated by LEGACY_TRACKER_COMPAT, default on) so tracker.js
 * snippets embedded before the PocketScience rename keep working without
 * a re-embed — set LEGACY_TRACKER_COMPAT=false once nothing sends it
 * anymore to drop the fallback.
 *
 * On the FIRST POST for a sid: server creates the session row from the
 * query params + UA + IP. On subsequent POSTs: server just appends the
 * gzipped chunk and bumps activity. There is no auth token — the
 * projectKey lives in the public tracker.js script tag anyway, so the
 * old JWT only added complexity without changing the threat model.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, count, eq, sql } from 'drizzle-orm';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseUA } from '@/lib/ua';
import { countryFromHeaders } from '@/lib/geoip';
import { splitAtCap, cappedDurationMs } from '@/lib/session-cap';
import { hrefOf, type RawEvent } from '@/lib/url-timeline';
import { matchesSessionCount, matchingUrlContainsRules, matchingCreationRules, matchingDurationRules, tagSession } from '@/lib/tag-rules';
import { deviceOf } from '@/lib/timeline';
import { categorizeSource } from '@/lib/traffic-source';
import { isExcluded } from '@/lib/excluded-users';

const MAX_BYTES_PER_SESSION = 10 * 1024 * 1024; // 10 MB
// The hard session-length cap (MAX_SESSION_DURATION_MS) is enforced server-side
// — so a stale/cached tracker.js can't push past it — measured by event span
// (firstEventTs → lastEventTs), not wall-clock since first POST. Idle gaps don't
// count, and dashboard duration matches what the player actually scrubs through.

// See the header doc comment above — flip to 'false' once nothing sends
// the pre-rebrand x-mega-end header anymore.
const LEGACY_TRACKER_COMPAT = process.env.LEGACY_TRACKER_COMPAT !== 'false';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  // Both the current and pre-rebrand end-of-session header are always
  // allowed through CORS preflight, regardless of LEGACY_TRACKER_COMPAT —
  // that flag only controls whether the legacy header is still HONORED,
  // not whether the browser is allowed to send it.
  'access-control-allow-headers': 'content-type, content-encoding, x-ps-end, x-mega-end',
  // The tracker reads the per-project session cap off responses.
  'access-control-expose-headers': 'x-max-session-ms',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventLine = { raw: string; ts: number | null; href: string | null };

function parseEventLines(plainText: string): EventLine[] {
  const out: EventLine[] = [];
  for (const raw of plainText.split('\n')) {
    if (!raw.trim()) continue;
    let ts: number | null = null;
    let href: string | null = null;
    try {
      const p = JSON.parse(raw) as RawEvent;
      if (typeof p.timestamp === 'number' && p.timestamp > 0) ts = p.timestamp;
      href = hrefOf(p);
    } catch {}
    out.push({ raw, ts, href });
  }
  return out;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest | Request) {
  const url = new URL(req.url);
  const projectKey = url.searchParams.get('k');
  const sid = url.searchParams.get('sid');
  const anonId = url.searchParams.get('a');
  const pageUrl = url.searchParams.get('u') || null;
  const referrer = (url.searchParams.get('r') || '').slice(0, 512) || null;
  const clientPageCount = parseInt(url.searchParams.get('p') || '0', 10) || 0;
  const isEnd = req.headers.get('x-ps-end') === '1'
    || (LEGACY_TRACKER_COMPAT && req.headers.get('x-mega-end') === '1');

  if (!projectKey || !sid || !anonId) {
    return NextResponse.json({ error: 'k, sid, a required' }, { status: 400, headers: CORS });
  }
  if (!UUID_RE.test(sid)) {
    // Reject non-UUID sids so guessed/colliding values don't pollute
    // the table. Client uses crypto.randomUUID().
    return NextResponse.json({ error: 'sid must be a uuid' }, { status: 400, headers: CORS });
  }

  // Read body. Client may abort mid-upload on page unload — treat as no-op
  // so logs aren't filled with bogus 500s.
  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await req.arrayBuffer());
  } catch {
    return new Response(null, { status: 204, headers: CORS });
  }

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
  if (!project) return NextResponse.json({ error: 'unknown projectKey' }, { status: 401, headers: CORS });

  // Excluded anon_ids (admin/maintenance browsing) — quiet no-op before
  // any session row is created or blob stored. Client gets 204 same as
  // a normal successful POST, so it doesn't retry.
  if (await isExcluded(project.id, anonId)) {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Body may be gzipped (regular flush) or plain ndjson (the very rare
  // fallback path). Parse to NDJSON so we can read event timestamps and
  // enforce the per-session video-length cap below.
  let plainText = '';
  if (rawBody.length > 0) {
    const isGzipped = req.headers.get('content-encoding') === 'gzip';
    try {
      plainText = (isGzipped ? gunzipSync(rawBody) : rawBody).toString('utf8');
    } catch {
      return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS });
    }
  }
  const events = parseEventLines(plainText);
  const validTimestamps = events.map((e) => e.ts).filter((t): t is number => t != null);
  const batchMinTs = validTimestamps.length ? Math.min(...validTimestamps) : null;

  const rules = await db.select().from(schema.tagRules)
    .where(and(eq(schema.tagRules.projectId, project.id), eq(schema.tagRules.enabled, true)));
  // Any URL the visitor reached this batch — the page-load param or a
  // captured event's href — counts, regardless of whether that event
  // survives the cap below (they still navigated there for real).
  const matchedRuleIds = matchingUrlContainsRules(rules, pageUrl, events.map((e) => e.href)).map((r) => r.id);

  // Upsert the session row. startedAt is the timestamp of the earliest
  // rrweb event ever seen for this sid — i.e. when the page loaded, not
  // when the first POST reached us. This makes the 5-min cap below count
  // actual recorded video length, not server wall-clock.
  const ua = parseUA(req.headers.get('user-agent') || '');
  const country = await countryFromHeaders(req.headers);
  const now = new Date();
  const startedAtCandidate = batchMinTs != null ? new Date(batchMinTs) : now;
  const inserted = await db.insert(schema.sessions).values({
    id: sid,
    projectId: project.id,
    anonId,
    pageUrl,
    referrer,
    userAgent: req.headers.get('user-agent') || '',
    browser: ua.browser,
    os: ua.os,
    country,
    startedAt: startedAtCandidate,
    lastActivityAt: now,
  }).onConflictDoNothing().returning({ id: schema.sessions.id });

  // session_count_gte and the single-fact rule kinds (browser/country/
  // device/referrer/source) only make sense once, when the session is
  // created — none of these inputs change mid-session.
  if (inserted.length > 0) {
    const [{ value: sessionNumber }] = await db.select({ value: count() }).from(schema.sessions)
      .where(and(eq(schema.sessions.projectId, project.id), eq(schema.sessions.anonId, anonId)));
    for (const r of rules) {
      if (r.kind === 'session_count_gte' && matchesSessionCount(r.value, sessionNumber)) {
        matchedRuleIds.push(r.id);
      }
    }
    const creationMatches = matchingCreationRules(rules, {
      browser: ua.browser,
      country,
      device: deviceOf(req.headers.get('user-agent') || ''),
      referrer,
      source: categorizeSource(referrer, pageUrl),
    });
    matchedRuleIds.push(...creationMatches.map((r) => r.id));
  }

  const [existing] = await db.select({
    blobBytes: schema.sessions.blobBytes,
    anonId: schema.sessions.anonId,
    startedAt: schema.sessions.startedAt,
    endedAt: schema.sessions.endedAt,
  }).from(schema.sessions).where(eq(schema.sessions.id, sid));
  if (!existing) return NextResponse.json({ error: 'session not found' }, { status: 404, headers: CORS });
  if (existing.anonId !== anonId) {
    // Don't let a different anonId hijack this sid. Cheap safety net.
    return NextResponse.json({ error: 'anon mismatch' }, { status: 403, headers: CORS });
  }

  // Filter events past the project's session cap. Events without
  // parseable timestamps are kept (rrweb always emits one, so a parse
  // failure is exotic — drop the safety check in favor of not silently
  // losing data).
  const capMs = Math.max(1, project.maxSessionMinutes) * 60_000;
  const RESP = { ...CORS, 'x-max-session-ms': String(capMs) };
  const startedAtMs = existing.startedAt.getTime();
  const cutoffMs = startedAtMs + capMs;
  const { kept, droppedAny } = splitAtCap(events, startedAtMs, capMs);

  // If the session was already closed by a previous cap-trigger, or if
  // every event in this batch is past the cap, tell the client to stop.
  // 410 Gone is treated client-side the same as 413 (hard stop).
  if (existing.endedAt && existing.endedAt.getTime() >= cutoffMs - 1) {
    return new Response(null, { status: 410, headers: RESP });
  }
  if (events.length > 0 && kept.length === 0) {
    await db.update(schema.sessions).set({
      endedAt: new Date(cutoffMs),
      durationMs: capMs,
    }).where(eq(schema.sessions.id, sid));
    return new Response(null, { status: 410, headers: RESP });
  }

  // Re-encode the kept events (gzip them as one member so the blob
  // stays valid concatenated-gzip).
  let bodyToStore: Buffer = Buffer.alloc(0);
  if (kept.length > 0) {
    const ndjson = Buffer.from(kept.map((e) => e.raw).join('\n') + '\n');
    bodyToStore = gzipSync(ndjson);
  }

  if ((existing.blobBytes + bodyToStore.length) > MAX_BYTES_PER_SESSION) {
    return NextResponse.json({ error: 'session too large' }, { status: 413, headers: CORS });
  }

  // Duration = event-span, capped. Use the latest kept event ts; if this
  // batch had none with timestamps, fall back to existing durationMs via
  // GREATEST so we never go backwards.
  const keptTimestamps = kept.map((e) => e.ts).filter((t): t is number => t != null);
  const batchMaxTs = keptTimestamps.length ? Math.max(...keptTimestamps) : startedAtMs;
  const cappedDuration = cappedDurationMs(startedAtMs, batchMaxTs, capMs);

  // duration_gte rules only ever grow more true, never less — safe to
  // re-check every batch against this batch's span and rely on
  // tagSession's onConflictDoNothing for stickiness once it first fires.
  const durationMatches = matchingDurationRules(rules, Math.floor(cappedDuration / 1000));
  matchedRuleIds.push(...durationMatches.map((r) => r.id));

  const update: Record<string, unknown> = {
    lastActivityAt: now,
    durationMs: sql`LEAST(GREATEST(COALESCE(${schema.sessions.durationMs}, 0), ${cappedDuration}), ${capMs})`,
    pageCount: sql`GREATEST(${schema.sessions.pageCount}, ${clientPageCount})`,
  };
  if (bodyToStore.length > 0) {
    update.blobData = sql`${schema.sessions.blobData} || ${bodyToStore}::bytea`;
    update.blobBytes = sql`${schema.sessions.blobBytes} + ${bodyToStore.length}`;
    update.eventCount = sql`${schema.sessions.eventCount} + ${kept.length}`;
  }
  // Close the session when the client says so, OR when this batch was
  // partially past the cap (we know more is coming and we don't want it).
  if (isEnd) update.endedAt = now;
  else if (droppedAny) update.endedAt = new Date(Math.min(batchMaxTs, cutoffMs));

  await db.update(schema.sessions).set(update).where(eq(schema.sessions.id, sid));
  if (matchedRuleIds.length > 0) await tagSession(sid, [...new Set(matchedRuleIds)]);

  // Tell the client the cap is reached so it stops sending further chunks.
  if (droppedAny) return new Response(null, { status: 410, headers: RESP });
  return new Response(null, { status: 204, headers: RESP });
}
