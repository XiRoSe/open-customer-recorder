import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, sql } from 'drizzle-orm';
import { verifyIngestToken } from '@/lib/ingest-token';
import { MAX_SESSION_DURATION_MS } from '@/lib/session-cap';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-recorder-token',
};
export async function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const token = req.headers.get('x-recorder-token') || url.searchParams.get('t');
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401, headers: CORS });
  let payload;
  try { payload = await verifyIngestToken(token); }
  catch { return NextResponse.json({ error: 'bad token' }, { status: 401, headers: CORS }); }
  if (payload.sessionId !== id) return NextResponse.json({ error: 'token mismatch' }, { status: 403, headers: CORS });

  const text = await req.text();
  let body: Record<string, unknown> = {};
  if (text) { try { body = JSON.parse(text); } catch { /* ignore parse errors */ } }
  const clientPageCount = typeof body.page_count === 'number' ? body.page_count : 0;
  const isPing = body.ping === true;

  // Duration is bounded by the per-session video cap. This endpoint is
  // metadata-only (no rrweb events), so the best signal of actual
  // recorded length is the events endpoint's running durationMs. Keep
  // GREATEST so a late /end ping never decrements an event-derived value;
  // LEAST clamps to the 5-min cap whether the events route saw the cap
  // or not.
  const update: Record<string, unknown> = {
    durationMs: sql`LEAST(GREATEST(COALESCE(${schema.sessions.durationMs}, 0), EXTRACT(EPOCH FROM (now() - ${schema.sessions.startedAt})) * 1000), ${MAX_SESSION_DURATION_MS})`,
    pageCount: sql`GREATEST(${schema.sessions.pageCount}, ${clientPageCount})`,
    lastActivityAt: new Date(),
  };
  if (!isPing) update.endedAt = new Date();

  await db.update(schema.sessions)
    .set(update)
    .where(eq(schema.sessions.id, id));

  return new Response(null, { status: 204, headers: CORS });
}
