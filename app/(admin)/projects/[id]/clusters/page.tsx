import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { clustersDataForProject, MIN_PROFILES_TO_CLUSTER } from '@/lib/user-segments';
import { ClusterMap } from '@/components/cluster-map';
import { Card } from '@/components/ui/card';

export default async function ClustersPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const dims = await clustersDataForProject(id);
  const points = dims[0]?.points ?? [];
  const segmentCount = dims.find((d) => d.dimension === 'overall')?.segments.length ?? 0;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Clusters</h1>
          <p className="text-sm text-muted-foreground">
            Your visitors, mapped by similarity and grouped into behavioral segments — each research
            dimension asks a different question of the same people. Switch a dimension to watch the
            cohort regroup; hover any dot for its story, click through to the sessions behind it.
          </p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <Link href={`/projects/${id}/sessions`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/users`} className="text-muted-foreground hover:underline">Users</Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Clusters</span>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/tags`} className="text-muted-foreground hover:underline">Tags</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/settings`} className="text-muted-foreground hover:underline">Settings</Link>
        </div>
      </div>

      {points.length > 0 ? (
        <Card className="p-4">
          <ClusterMap dims={dims} sessionsBasePath={`/projects/${id}/sessions`} />
        </Card>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No clusters yet. Segments appear automatically once at least {MIN_PROFILES_TO_CLUSTER} visitors
          have AI profiles (a profile needs 2+ summarized sessions) — reclustering runs every few minutes.
        </Card>
      )}
    </main>
  );
}
