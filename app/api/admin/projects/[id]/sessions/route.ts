import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, and, gte, lte, desc, count, sql, getTableColumns } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

export async function GET(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id: projectId } = await ctx.params;
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const userQuery = url.searchParams.get('user');
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const pageSize = 50;

  // Confirm project belongs to session.orgId
  const [project] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, session.orgId)));
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const conds = [eq(schema.sessions.projectId, projectId)];
  if (from) conds.push(gte(schema.sessions.startedAt, new Date(from)));
  if (to) conds.push(lte(schema.sessions.startedAt, new Date(to)));
  if (userQuery) {
    conds.push(sql`(${schema.sessions.userId} ILIKE ${`%${userQuery}%`} OR ${schema.sessions.email} ILIKE ${`%${userQuery}%`})`);
  }

  const where = and(...conds);
  const [{ value: total }] = await db.select({ value: count() }).from(schema.sessions).where(where);
  // Exclude blob_data: it would be JSON-serialized into the response.
  const { blobData: _blobData, ...listColumns } = getTableColumns(schema.sessions);
  const sessions = await db.select(listColumns).from(schema.sessions)
    .where(where)
    .orderBy(desc(schema.sessions.startedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return NextResponse.json({ project, sessions, total, page, pageSize });
}
