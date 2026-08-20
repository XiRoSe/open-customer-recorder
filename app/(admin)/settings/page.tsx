import { redirect } from 'next/navigation';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';

/** Settings moved inside the project container — this old standalone URL
 * just forwards to the first project's settings tab. */
export default async function SettingsRedirect() {
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(eq(schema.projects.orgId, session.orgId)).limit(1);
  redirect(project ? `/projects/${project.id}/settings` : '/projects');
}
