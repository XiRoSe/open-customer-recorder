import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';
import { threadMessages } from '@/lib/researcher/threads';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; threadId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, threadId } = await ctx.params;
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId))).limit(1);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const messages = await threadMessages(id, session.userId, threadId);
  if (!messages) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ messages });
}
