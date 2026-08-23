import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq, gt, desc } from 'drizzle-orm';
import { signIngestToken } from '@/lib/ingest-token';
import { parseUA } from '@/lib/ua';
import { countryFromHeaders } from '@/lib/geoip';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-recorder-token, content-encoding',
};

// If the same anonId pinged within this window, resume the existing session
// instead of creating a new one (so quick tab close + reopen looks like one session).
const RESUME_WINDOW_MS = 5 * 60 * 1000;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest | Request) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS });

  const projectKey = typeof body.projectKey === 'string' ? body.projectKey : null;
  const anonId = typeof body.anonId === 'string' ? body.anonId : null;
  const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl : null;
  const userAgent = typeof body.userAgent === 'string' ? body.userAgent : (req.headers.get('user-agent') || '');
  if (!projectKey || !anonId) {
    return NextResponse.json({ error: 'projectKey and anonId required' }, { status: 400, headers: CORS });
  }

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
  if (!project) return NextResponse.json({ error: 'unknown projectKey' }, { status: 401, headers: CORS });

  // Try to resume a recent session for this anonId on this project.
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);
  const [recent] = await db.select({ id: schema.sessions.id }).from(schema.sessions)
    .where(and(
      eq(schema.sessions.projectId, project.id),
      eq(schema.sessions.anonId, anonId),
      gt(schema.sessions.lastActivityAt, cutoff),
    ))
    .orderBy(desc(schema.sessions.lastActivityAt))
    .limit(1);

  if (recent) {
    // Bump activity + return the existing session id
    await db.update(schema.sessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(schema.sessions.id, recent.id));
    const ingestToken = await signIngestToken({ sessionId: recent.id, projectId: project.id });
    return NextResponse.json({
      sessionId: recent.id,
      ingestToken,
      privacyMode: project.privacyMode,
      resumed: true,
    }, { headers: CORS });
  }

  // No resumable session — create a new one
  const ua = parseUA(userAgent);
  const country = await countryFromHeaders(req.headers);

  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id,
    anonId,
    pageUrl,
    userAgent,
    browser: ua.browser,
    os: ua.os,
    country,
    startedAt: new Date(),
    lastActivityAt: new Date(),
  }).returning({ id: schema.sessions.id });

  const ingestToken = await signIngestToken({ sessionId: s.id, projectId: project.id });
  return NextResponse.json({
    sessionId: s.id,
    ingestToken,
    privacyMode: project.privacyMode,
  }, { headers: CORS });
}
