/**
 * Mark every session in this project viewed by the calling admin. Called
 * from the "Mark all as viewed" button on the sessions list. Per-admin, so
 * it only clears the caller's own unviewed list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { markProjectSessionsViewed } from '@/lib/session-views';

export async function POST(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;

  // Make sure this project belongs to the caller's org before bulk-updating.
  const [project] = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await markProjectSessionsViewed(id, session.email);

  return NextResponse.json({ ok: true });
}
