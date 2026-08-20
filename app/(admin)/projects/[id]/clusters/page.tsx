import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { getAppSettings } from '@/lib/app-settings';
import { segmentsForProject, clusterMapForProject, MIN_PROFILES_TO_CLUSTER } from '@/lib/user-segments';
import { ClusterMap } from '@/components/cluster-map';
import { SettingsToggles } from '@/components/settings-toggles';
import { Card } from '@/components/ui/card';

export default async function ClustersPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const [segments, points, settings] = await Promise.all([
    segmentsForProject(id),
    clusterMapForProject(id),
    getAppSettings(session.orgId),
  ]);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Clusters</h1>
          <p className="text-sm text-muted-foreground">
            {points.length.toLocaleString()} visitors mapped by profile similarity into {segments.length} {segments.length === 1 ? 'segment' : 'segments'} — hover a dot for the profile, click to open that visitor&apos;s sessions.
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
          <Link href="/settings" className="text-muted-foreground hover:underline">Settings</Link>
        </div>
      </div>

      {points.length > 0 ? (
        <Card className="p-4">
          <ClusterMap points={points} segments={segments} sessionsBasePath={`/projects/${id}/sessions`} />
        </Card>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No clusters yet. Segments appear automatically once at least {MIN_PROFILES_TO_CLUSTER} visitors
          have AI profiles (a profile needs 2+ summarized sessions) — reclustering runs every few minutes.
        </Card>
      )}

      <div>
        <h2 className="font-semibold mb-2">Clustering settings</h2>
        <SettingsToggles initial={settings} only={['profilesEnabled', 'clusteringEnabled']} />
      </div>
    </main>
  );
}
