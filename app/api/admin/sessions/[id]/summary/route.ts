import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

async function ownedSessionId(id: string, orgId: string): Promise<string | null> {
  const rows = await db.select({ id: schema.sessions.id }).from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, orgId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function GET(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownedSessionId(id, session.orgId))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const [row] = await db.select({
    narrative: schema.sessionSummaries.narrative,
    insights: schema.sessionSummaries.insights,
    intentText: schema.sessionSummaries.intentText,
    status: schema.sessionSummaries.status,
  }).from(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, id)).limit(1);
  return NextResponse.json({ summary: row ?? null });
}

/** Regenerate: back to pending so the next worker cycle re-runs the LLM.
 * (The digest itself refreshes via digestVersion, not this endpoint.) */
export async function POST(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownedSessionId(id, session.orgId))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await db.update(schema.sessionSummaries)
    .set({ status: 'pending', attempts: 0, nextRetryAt: null, updatedAt: new Date() })
    .where(eq(schema.sessionSummaries.sessionId, id));
  return NextResponse.json({ ok: true });
}
