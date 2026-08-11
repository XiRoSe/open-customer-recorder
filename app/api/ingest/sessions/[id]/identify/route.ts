import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { verifyIngestToken } from '@/lib/ingest-token';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-recorder-token',
};
export async function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function POST(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const token = req.headers.get('x-recorder-token');
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401, headers: CORS });
  let payload;
  try { payload = await verifyIngestToken(token); }
  catch { return NextResponse.json({ error: 'bad token' }, { status: 401, headers: CORS }); }
  if (payload.sessionId !== id) return NextResponse.json({ error: 'token mismatch' }, { status: 403, headers: CORS });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS });

  const userId = typeof body.userId === 'string' ? body.userId : null;
  const email = typeof body.email === 'string' ? body.email : null;
  const displayName = typeof body.displayName === 'string' ? body.displayName : null;

  await db.update(schema.sessions)
    .set({ userId, email, displayName })
    .where(eq(schema.sessions.id, id));

  return new Response(null, { status: 204, headers: CORS });
}
