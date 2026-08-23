import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

/** Update project data settings: retention window and the per-session
 * recording cap. Retention applies on the hourly cycle; the session cap
 * reaches running trackers via the events-response header. */
export async function PATCH(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const patch: Record<string, number> = {};
  if (body.retentionDays !== undefined) {
    const v = Number(body.retentionDays);
    if (!Number.isInteger(v) || v < 1 || v > 365) {
      return NextResponse.json({ error: 'retentionDays must be an integer between 1 and 365' }, { status: 400 });
    }
    patch.retentionDays = v;
  }
  if (body.maxSessionMinutes !== undefined) {
    const v = Number(body.maxSessionMinutes);
    if (!Number.isInteger(v) || v < 1 || v > 60) {
      return NextResponse.json({ error: 'maxSessionMinutes must be an integer between 1 and 60' }, { status: 400 });
    }
    patch.maxSessionMinutes = v;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'retentionDays and/or maxSessionMinutes required' }, { status: 400 });
  }

  const [updated] = await db.update(schema.projects).set(patch)
    .where(eq(schema.projects.id, id))
    .returning({
      id: schema.projects.id,
      retentionDays: schema.projects.retentionDays,
      maxSessionMinutes: schema.projects.maxSessionMinutes,
    });
  return NextResponse.json({ project: updated });
}
