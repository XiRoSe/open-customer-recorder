import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { timelineForProject, timelineAnalysis, TIMELINE_RANGES, DEFAULT_RANGE } from '@/lib/timeline';
import { SOURCE_CATEGORIES, SOURCE_META } from '@/lib/traffic-source';
import { TimelineChart } from '@/components/timeline-chart';
import { Card } from '@/components/ui/card';

const DIRECTION_GLYPH: Record<string, string> = { up: '▲', down: '▼', flat: '—' };

export default async function TimelinePage(props: {
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

  const rangeKey = TIMELINE_RANGES[rangeParam ?? ''] ? rangeParam! : DEFAULT_RANGE;
  const [data, analysis] = await Promise.all([
    timelineForProject(id, rangeKey),
    timelineAnalysis(id, rangeKey),
  ]);
  const basePath = `/projects/${id}/timeline`;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Timeline</h1>
          <p className="text-sm text-muted-foreground">
            {data.totals.sessions.toLocaleString()} {data.totals.sessions === 1 ? 'session' : 'sessions'} in the {TIMELINE_RANGES[rangeKey].label}
            {data.totals.sessions > 0 ? <>
              {' '}· <span className="font-medium text-foreground">{data.totals.engaged}</span> engaged
              {' '}· <span className="font-medium text-foreground">{data.totals.frustrated}</span> with friction
              {' '}· <span className="font-medium text-foreground">{data.totals.newVisitors}</span> new {data.totals.newVisitors === 1 ? 'visitor' : 'visitors'}
            </> : null}
          </p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <Link href={`/projects/${id}/sessions`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Timeline</span>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/users`} className="text-muted-foreground hover:underline">Users</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/clusters`} className="text-muted-foreground hover:underline">Clusters</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/tags`} className="text-muted-foreground hover:underline">Tags</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/settings`} className="text-muted-foreground hover:underline">Settings</Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div role="tablist" aria-label="Time range" className="inline-flex rounded-lg border p-0.5 gap-0.5">
          {Object.keys(TIMELINE_RANGES).map((key) => (
            <Link
              key={key}
              role="tab"
              aria-selected={key === rangeKey}
              href={key === DEFAULT_RANGE ? basePath : `${basePath}?range=${key}`}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                key === rangeKey ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {key}
            </Link>
          ))}
        </div>
        {/* trend chips — deterministic, period over period */}
        <div className="flex flex-wrap gap-1.5">
          {data.trends.map((t) => (
            <span
              key={t.label}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                t.direction === 'up' && t.label === 'Frustration' ? 'text-rose-700 dark:text-rose-400 bg-rose-500/10'
                : t.direction === 'up' ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                : t.direction === 'down' && t.label === 'Frustration' ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                : t.direction === 'down' ? 'text-amber-700 dark:text-amber-400 bg-amber-500/10'
                : 'text-muted-foreground'
              }`}
              title={`${t.label}, compared to the previous ${TIMELINE_RANGES[rangeKey].label.replace('last ', '')}`}
            >
              <span aria-hidden>{DIRECTION_GLYPH[t.direction]}</span>
              {t.label}: {t.value}
            </span>
          ))}
        </div>
      </div>

      {analysis && (
        <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Analyst read</div>
          <p className="text-sm leading-relaxed m-0 max-w-4xl">{analysis}</p>
        </div>
      )}

      {data.totals.sessions > 0 ? (
        <Card className="p-4">
          <TimelineChart buckets={data.buckets} bucketMs={data.bucketMs} sessionsBasePath={`/projects/${id}/sessions`} />
        </Card>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No sessions in the {TIMELINE_RANGES[rangeKey].label}.
        </Card>
      )}

      {/* table view of the same data — sources over the window */}
      {data.totals.sessions > 0 && (
        <Card className="p-0 divide-y">
          {SOURCE_CATEGORIES.filter((s) => data.totals.bySource[s] > 0)
            .sort((a, b) => data.totals.bySource[b] - data.totals.bySource[a])
            .map((s) => {
              const n = data.totals.bySource[s];
              const share = Math.round((100 * n) / data.totals.sessions);
              return (
                <div key={s} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: SOURCE_META[s].color }} />
                  <span className="w-20">{SOURCE_META[s].label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${share}%`, background: SOURCE_META[s].color }} />
                  </div>
                  <span className="tabular-nums text-muted-foreground w-20 text-right">{n} · {share}%</span>
                </div>
              );
            })}
        </Card>
      )}
    </main>
  );
}
