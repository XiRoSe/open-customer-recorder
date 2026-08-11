import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { unexcludeUser } from '@/lib/excluded-users';

export async function DELETE(_req: NextRequest | Request, ctx: { params: Promise<{ id: string; anonId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, anonId } = await ctx.params;

  const [project] = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await unexcludeUser(id, decodeURIComponent(anonId));
  return NextResponse.json({ ok: true });
}
