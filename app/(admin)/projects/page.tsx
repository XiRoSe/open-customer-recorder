import { redirect } from 'next/navigation';
import { db, schema } from '@/lib/db';
import { eq, desc } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

/**
 * Single-project MVP: redirect straight to the only project's sessions page.
 * The route exists for forward-compat (when multi-project lands) but no UI today.
 */
export default async function ProjectsPage() {
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(eq(schema.projects.orgId, session.orgId))
    .orderBy(desc(schema.projects.createdAt))
    .limit(1);
  if (!project) redirect('/login');
  redirect(`/projects/${project.id}/sessions`);
}
