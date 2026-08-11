import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { deleteSessionBlob } from '@/lib/blob';

/**
 * Danger: deletes ALL session rows + their blob files for every project
 * the calling admin owns. Requires the admin session cookie AND a
 * confirmation header so we don't fat-finger it.
 *
 * curl -X POST <origin>/api/admin/sessions/wipe \
 *   -H 'x-confirm: yes-delete-all' \
 *   -b 'mega_session=<jwt>'
 */
export async function POST(req: Request) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.headers.get('x-confirm') !== 'yes-delete-all') {
    return NextResponse.json({ error: 'missing x-confirm header' }, { status: 400 });
  }

  const projects = await db.select().from(schema.projects).where(eq(schema.projects.orgId, session.orgId));
  let deleted = 0;
  for (const p of projects) {
    const ids = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.projectId, p.id));
    for (const s of ids) {
      await deleteSessionBlob(s.id).catch(() => {});
    }
    const result = await db.delete(schema.sessions).where(eq(schema.sessions.projectId, p.id)).returning({ id: schema.sessions.id });
    deleted += result.length;
  }
  return NextResponse.json({ ok: true, deleted });
}
