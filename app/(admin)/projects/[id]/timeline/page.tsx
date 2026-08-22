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

// Short, plain explanations of each measurement — shown on hover.
const CHIP_EXPLAINERS: Record<string, string> = {
  'Sessions': 'Recorded visits in this window.',
  'Engaged (30s+)': 'Share of sessions lasting at least 30 seconds.',
  'Frustration': 'Share of sessions with at least one frustration signal: rage clicks, dead clicks, abandoned forms, refresh loops.',
  'New visitors': 'Share of sessions from visitors seen here for the first time.',
  'Emerging source': 'The traffic source whose share grew the most.',
};

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
  const [data, { analysis, patterns }] = await Promise.all([
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
              {' '}· <span className="font-medium text-foreground cursor-help" title="Sessions lasting at least 30 seconds.">{data.totals.engaged} engaged</span>
              {' '}· <span className="font-medium text-foreground cursor-help" title="Sessions with at least one frustration signal: rage clicks, dead clicks, abandoned forms, refresh loops.">{data.totals.frustrated} with friction</span>
              {' '}· <span className="font-medium text-foreground cursor-help" title="Visitors recorded here for the first time in this window.">{data.totals.newVisitors} new {data.totals.newVisitors === 1 ? 'visitor' : 'visitors'}</span>
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
              title={`${CHIP_EXPLAINERS[t.label] ?? t.label}${rangeKey !== 'all' ? ` Compared with the previous ${TIMELINE_RANGES[rangeKey].label.replace('last ', '')}.` : ''}`}
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
          <TimelineChart buckets={data.buckets} bucketMs={data.bucketMs} tagMeta={data.tagMeta} sessionsBasePath={`/projects/${id}/sessions`} />
        </Card>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No sessions in the {TIMELINE_RANGES[rangeKey].label}.
        </Card>
      )}

      {/* measurement breakdowns — one titled section per lens */}
      {data.totals.sessions > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
                 title="Where sessions came from, derived from each session's referrer and entry URL.">Traffic sources</div>
            <div className="space-y-2.5">
              {SOURCE_CATEGORIES.filter((s) => data.totals.bySource[s] > 0)
                .sort((a, b) => data.totals.bySource[b] - data.totals.bySource[a])
                .map((s) => {
                  const n = data.totals.bySource[s];
                  const share = Math.round((100 * n) / data.totals.sessions);
                  return (
                    <div key={s} className="flex items-center gap-3 text-sm">
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: SOURCE_META[s].color }} />
                      <span className="w-16">{SOURCE_META[s].label}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${share}%`, background: SOURCE_META[s].color }} />
                      </div>
                      <span className="tabular-nums text-muted-foreground w-20 text-right">{n} · {share}%</span>
                    </div>
                  );
                })}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
                 title="How deeply visitors engaged, and how many are seeing the site for the first time.">Engagement &amp; visitors</div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <div className="text-xl font-semibold tabular-nums" title="Mean recorded session length in this window.">{fmtDur(data.totals.avgDurationMs)}</div>
                <div className="text-xs text-muted-foreground">Avg session</div>
              </div>
              <div>
                <div className="text-xl font-semibold tabular-nums" title="Sessions lasting at least 30 seconds.">{Math.round((100 * data.totals.engaged) / data.totals.sessions)}%</div>
                <div className="text-xs text-muted-foreground">Engaged (30s+)</div>
              </div>
              <div>
                <div className="text-xl font-semibold tabular-nums" title="Distinct visitors recorded here for the first time in this window.">{data.totals.newVisitors}</div>
                <div className="text-xs text-muted-foreground">New visitors</div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground mb-1.5" title="Sessions from first-time visitors vs visitors who had been here before this window.">
              New vs returning sessions
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-muted">
              <div className="bg-foreground/80" style={{ width: `${Math.round((100 * data.totals.newSessions) / data.totals.sessions)}%` }} />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1 tabular-nums">
              <span>{data.totals.newSessions} new</span>
              <span>{data.totals.sessions - data.totals.newSessions} returning</span>
            </div>
          </Card>

          {Object.keys(data.totals.insightCounts).length > 0 && (
            <Card className="p-4 lg:col-span-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
                   title="Frustration signals detected automatically in this window's sessions.">Friction signals</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {Object.entries(data.totals.insightCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([kind, n]) => (
                    <div key={kind}>
                      <div className="text-xl font-semibold tabular-nums">{n}</div>
                      <div className="text-xs text-muted-foreground">{INSIGHT_LABELS[kind] ?? kind}</div>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* LLM pattern read: peak/dead times, the opening, the risk —
          built in the background from deterministic aggregates. */}
      {patterns && data.totals.sessions > 0 && (
        <Card className="p-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
               title="An analyst read of this window's rhythm: when traffic peaks, when it goes quiet, the most actionable opening, and what to keep an eye on. Generated from the measured numbers above.">
            Patterns &amp; opportunities
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            {([
              ['Peak times', patterns.peaks, 'When sessions concentrate — the hours or days your traffic actually shows up.'],
              ['Quiet times', patterns.quiet, 'Stretches with little to no traffic, and what they imply.'],
              ['Opportunity', patterns.opportunity, 'The most actionable opening in this window’s numbers.'],
              ['Worth watching', patterns.watch, 'The metric or pattern most likely to change your read next.'],
            ] as const).filter(([, body]) => body).map(([label, body, explain]) => (
              <div key={label} className="border-l-2 border-foreground/20 pl-3">
                <div className="text-xs font-medium text-foreground mb-0.5 cursor-help" title={explain}>{label}</div>
                <p className="text-sm text-muted-foreground leading-relaxed m-0">{body}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </main>
  );
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const INSIGHT_LABELS: Record<string, string> = {
  rage_click: 'Rage clicks',
  dead_click: 'Dead clicks',
  form_abandon: 'Forms abandoned',
  uturn: 'Navigation U-turns',
  pogo_stick: 'Pogo-sticking',
  refresh_loop: 'Refresh loops',
};
