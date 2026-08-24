// Mint / revoke a read-only public link for one research thread. Only
// the thread's own owner may share it — no cross-admin sharing.
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';

async function ownedThread(threadId: string, projectId: string, userId: string) {
  const [t] = await db.select({ id: schema.researcherThreads.id, shareToken: schema.researcherThreads.shareToken })
    .from(schema.researcherThreads)
    .where(and(
      eq(schema.researcherThreads.id, threadId),
      eq(schema.researcherThreads.projectId, projectId),
      eq(schema.researcherThreads.userId, userId),
    )).limit(1);
  return t ?? null;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; threadId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, threadId } = await ctx.params;
  const thread = await ownedThread(threadId, id, session.userId);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const token = thread.shareToken ?? nanoid(22);
  if (!thread.shareToken) {
    await db.update(schema.researcherThreads).set({ shareToken: token }).where(eq(schema.researcherThreads.id, threadId));
  }
  return NextResponse.json({ url: `/share/research/${token}` });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; threadId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, threadId } = await ctx.params;
  const thread = await ownedThread(threadId, id, session.userId);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.update(schema.researcherThreads).set({ shareToken: null }).where(eq(schema.researcherThreads.id, threadId));
  return NextResponse.json({ ok: true });
}
