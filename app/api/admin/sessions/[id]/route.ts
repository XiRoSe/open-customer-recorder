import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { deleteSessionBlob } from '@/lib/blob';

export async function GET(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const rows = await db.select({
    s: schema.sessions, p: schema.projects,
  }).from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ session: rows[0].s, project: rows[0].p });
}

export async function DELETE(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const rows = await db.select({ id: schema.sessions.id })
    .from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await deleteSessionBlob(id).catch(() => {});
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  return NextResponse.json({ ok: true });
}
