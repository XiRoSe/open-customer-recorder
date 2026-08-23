import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq, sql } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { clustersDataForProject, activeVisitorKeys, filterDimsByVisitors, MIN_PROFILES_TO_CLUSTER } from '@/lib/user-segments';
import { TIMELINE_RANGES } from '@/lib/timeline';
import { ClusterMap } from '@/components/cluster-map';
import { Card } from '@/components/ui/card';
import { HeaderRule } from '@/components/header-rule';

export default async function ClustersPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { id } = await props.params;
  const { range: rangeParam } = await props.searchParams;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  // Same ranges as the Timeline. Clustering is global — the range only
  // filters which visitors show: those with a session in the window.
  const rangeKey = TIMELINE_RANGES[rangeParam ?? ''] ? rangeParam! : 'all';
  const allDims = await clustersDataForProject(id);
  const mappedTotal = allDims[0]?.points.length ?? 0;
  const dims = rangeKey === 'all'
    ? allDims
    : filterDimsByVisitors(allDims, await activeVisitorKeys(id, new Date(Date.now() - TIMELINE_RANGES[rangeKey].windowMs)));
  const points = dims[0]?.points ?? [];
  const totalSegments = dims.reduce((s, d) => s + d.segments.length, 0);
  const [built] = await db.select({ at: sql<string>`max(${schema.userSegments.createdAt})` })
    .from(schema.userSegments).where(eq(schema.userSegments.projectId, id));
  const basePath = `/projects/${id}/clusters`;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Clusters</h1>
          <p className="text-sm text-muted-foreground">
            {rangeKey === 'all'
              ? <>{points.length.toLocaleString()} {points.length === 1 ? 'visitor' : 'visitors'} mapped</>
              : <><span className="font-medium text-foreground">{points.length.toLocaleString()} of {mappedTotal.toLocaleString()}</span> mapped visitors active in the {TIMELINE_RANGES[rangeKey].label}</>}
            {totalSegments > 0 ? <> · <span className="font-medium text-foreground">{totalSegments} segments</span> across {dims.length} {dims.length === 1 ? 'dimension' : 'dimensions'}</> : null}
            {built?.at ? <> · last analyzed {new Date(built.at).toLocaleString('en-GB')}</> : null}
          </p>
        </div>
      </div>

      <HeaderRule />

      {points.length > 0 ? (
        <ClusterMap dims={dims} sessionsBasePath={`/projects/${id}/sessions`}
                    rangeSlot={<ClusterRangePills basePath={basePath} rangeKey={rangeKey} />} />
      ) : mappedTotal > 0 ? (
        <>
          <ClusterRangePills basePath={basePath} rangeKey={rangeKey} />
          <Card className="p-8 text-center text-sm text-muted-foreground">
            None of the mapped visitors had a session in the {TIMELINE_RANGES[rangeKey].label}.
          </Card>
        </>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No clusters yet. Segments appear automatically once at least {MIN_PROFILES_TO_CLUSTER} visitors
          have AI profiles (a profile needs 2+ summarized sessions) — reclustering runs every few minutes.
        </Card>
      )}
    </main>
  );
}

function ClusterRangePills({ basePath, rangeKey }: { basePath: string; rangeKey: string }) {
  return (
    <div role="tablist" aria-label="Active in range" className="inline-flex rounded-lg border p-0.5 gap-0.5"
         title="Show only visitors with a recorded session in this range. Segments and positions stay as analyzed over the full history.">
      {Object.keys(TIMELINE_RANGES).map((key) => (
        <Link
          key={key}
          role="tab"
          aria-selected={key === rangeKey}
          href={key === 'all' ? basePath : `${basePath}?range=${key}`}
          className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
            key === rangeKey ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {key}
        </Link>
      ))}
    </div>
  );
}
