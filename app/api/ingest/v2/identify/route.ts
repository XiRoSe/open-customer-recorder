/**
 * v2 identify — no JWT. Auth by projectKey + anonId match on the
 * existing session row.
 *
 * POST /api/ingest/v2/identify?k=<projectKey>&sid=<sid>&a=<anonId>
 * Body: { userId?, email?, displayName? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(req: NextRequest | Request) {
  const url = new URL(req.url);
  const projectKey = url.searchParams.get('k');
  const sid = url.searchParams.get('sid');
  const anonId = url.searchParams.get('a');
  if (!projectKey || !sid || !anonId) {
    return NextResponse.json({ error: 'k, sid, a required' }, { status: 400, headers: CORS });
  }

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt);
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS });
  }

  const [project] = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.projectKey, projectKey))
    .limit(1);
  if (!project) return NextResponse.json({ error: 'unknown projectKey' }, { status: 401, headers: CORS });

  const [row] = await db.select({ anonId: schema.sessions.anonId, projectId: schema.sessions.projectId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sid))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404, headers: CORS });
  if (row.projectId !== project.id || row.anonId !== anonId) {
    return NextResponse.json({ error: 'mismatch' }, { status: 403, headers: CORS });
  }

  const userId = typeof body.userId === 'string' ? body.userId : null;
  const email = typeof body.email === 'string' ? body.email : null;
  const displayName = typeof body.displayName === 'string' ? body.displayName : null;

  await db.update(schema.sessions)
    .set({ userId, email, displayName })
    .where(and(eq(schema.sessions.id, sid), eq(schema.sessions.anonId, anonId)));

  return new Response(null, { status: 204, headers: CORS });
}
