import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, desc } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

export async function GET() {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const projects = await db.select().from(schema.projects)
    .where(eq(schema.projects.orgId, session.orgId))
    .orderBy(desc(schema.projects.createdAt));
  return NextResponse.json({ projects });
}
