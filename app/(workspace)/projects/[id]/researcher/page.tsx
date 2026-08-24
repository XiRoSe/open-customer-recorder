// The Researcher's full-screen workspace. Lives in its own route group
// so the admin top bar never renders here — the workspace owns the
// whole viewport until the user minimizes back to the dashboard.
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';
import { ResearcherWorkspace } from '@/components/researcher/workspace';

export default async function ResearcherWorkspacePage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ thread?: string; from?: string }>;
}) {
  const { id } = await props.params;
  const { thread, from } = await props.searchParams;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  return (
    <ResearcherWorkspace
      projectId={id}
      name={session.name}
      initialThreadId={thread ?? null}
      from={from ?? null}
    />
  );
}
