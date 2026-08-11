import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { excludeUser } from '@/lib/excluded-users';

export async function POST(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;

  const [project] = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const anonId = typeof body.anonId === 'string' ? body.anonId.trim() : '';
  if (!anonId) return NextResponse.json({ error: 'anonId is required' }, { status: 400 });

  await excludeUser(id, anonId);
  return NextResponse.json({ ok: true }, { status: 201 });
}
