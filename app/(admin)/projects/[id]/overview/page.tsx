import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { TIMELINE_RANGES } from '@/lib/timeline';
import { overviewForProject } from '@/lib/overview';
import { SEGMENT_PALETTE } from '@/lib/segment-palette';
import { Card } from '@/components/ui/card';

const READ_HEADING: Record<string, string> = {
  '24h': "Today's read", '7d': "This week's read", '30d': "This month's read", 'all': 'All-time read',
};

const DIRECTION_GLYPH: Record<string, string> = { up: '▲', down: '▼', flat: '—' };

export default async function OverviewPage(props: {
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

  const rangeKey = TIMELINE_RANGES[rangeParam ?? ''] ? rangeParam! : '7d';
  const ov = await overviewForProject(id, rangeKey);
  const { data } = ov;
  const t = data.totals;
  const basePath = `/projects/${id}/overview`;

  const trend = (label: string) => data.trends.find((c) => c.label === label);
  const sessionsTrend = trend('Sessions');
  const sessionsDelta = sessionsTrend?.value.match(/\(([^)]+)\)/)?.[1] ?? null;

  const deltaClass = (dir: string | undefined, invert = false) => {
    const d = dir ?? 'flat';
    const good = invert ? d === 'down' : d === 'up';
    const bad = invert ? d === 'up' : d === 'down';
    return good ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
      : bad ? 'text-amber-700 dark:text-amber-400 bg-amber-500/10'
      : 'text-muted-foreground bg-muted';
  };

  const fmtWhen = (d: Date) =>
    d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Overview</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{t.sessions.toLocaleString()} {t.sessions === 1 ? 'session' : 'sessions'}</span>
            {t.sessions > 0 ? <>
              {' '}· <span className="font-medium text-foreground cursor-help" title="Sessions lasting at least 30 seconds.">{t.engaged} engaged</span>
              {' '}· <span className="font-medium text-foreground cursor-help" title="Sessions with at least one frustration signal.">{t.frustrated} with friction</span>
            </> : null}
            {' '}in the {TIMELINE_RANGES[rangeKey].label}
          </p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <span className="font-medium">Overview</span>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/sessions`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/timeline`} className="text-muted-foreground hover:underline">Timeline</Link>
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

      <div role="tablist" aria-label="Time range" className="inline-flex rounded-lg border p-0.5 gap-0.5"
           title="Everything below — pulse, read, attention items, activity — follows the selected range.">
        {Object.keys(TIMELINE_RANGES).map((key) => (
          <Link key={key} role="tab" aria-selected={key === rangeKey}
                href={key === '7d' ? basePath : `${basePath}?range=${key}`}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  key === rangeKey ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
                }`}>
            {key}
          </Link>
        ))}
      </div>

      {t.sessions === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No sessions in the {TIMELINE_RANGES[rangeKey].label}.
        </Card>
      ) : (
        <>
          {/* pulse: four hero numbers + a quiet mini chart */}
          <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1.6fr] gap-4">
            <Card className="p-4" title={`Recorded visits in the ${TIMELINE_RANGES[rangeKey].label}${rangeKey !== 'all' ? ', vs the previous equal period' : ''}.`}>
              <div className="text-2xl font-semibold tabular-nums">{t.sessions.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Sessions</div>
              {sessionsDelta && (
                <span className={`inline-block mt-2 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${deltaClass(sessionsTrend?.direction)}`}>
                  {DIRECTION_GLYPH[sessionsTrend?.direction ?? 'flat']} {sessionsDelta}
                </span>
              )}
            </Card>
            <Card className="p-4" title="Share of sessions lasting at least 30 seconds.">
              <div className="text-2xl font-semibold tabular-nums">{Math.round((100 * t.engaged) / t.sessions)}%</div>
              <div className="text-xs text-muted-foreground">Engaged (30s+)</div>
              <span className={`inline-block mt-2 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${deltaClass(trend('Engaged (30s+)')?.direction)}`}>
                {DIRECTION_GLYPH[trend('Engaged (30s+)')?.direction ?? 'flat']} vs previous
              </span>
            </Card>
            <Card className="p-4" title="Share of sessions with at least one frustration signal: rage clicks, dead clicks, abandoned forms, refresh loops.">
              <div className="text-2xl font-semibold tabular-nums">{Math.round((100 * t.frustrated) / t.sessions)}%</div>
              <div className="text-xs text-muted-foreground">Friction</div>
              <span className={`inline-block mt-2 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${deltaClass(trend('Frustration')?.direction, true)}`}>
                {DIRECTION_GLYPH[trend('Frustration')?.direction ?? 'flat']} vs previous
              </span>
            </Card>
            <Card className="p-4" title="Distinct visitors recorded here for the first time in this window.">
              <div className="text-2xl font-semibold tabular-nums">{t.newVisitors.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">New visitors</div>
              <span className="inline-block mt-2 rounded-full px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground bg-muted">
                {Math.round((100 * t.newSessions) / t.sessions)}% of sessions
              </span>
            </Card>
            <Link href={`/projects/${id}/timeline${rangeKey === '7d' ? '' : `?range=${rangeKey}`}`} className="col-span-2 lg:col-span-1">
              <Card className="p-4 h-full hover:bg-muted/40 transition-colors" title="Sessions per slot in this window. Open the Timeline for the full picture.">
                <MiniChart buckets={data.buckets.map((b) => ({ start: b.start, total: b.total }))} />
                <div className="flex justify-between text-[11.5px] text-muted-foreground mt-1.5">
                  <span>{new Date(data.windowStart).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })}</span>
                  <span>Open Timeline →</span>
                </div>
              </Card>
            </Link>
          </div>

          {/* the read: cached analysis + the two sharpest pattern tiles */}
          {(ov.analysis || ov.patterns) && (
            <Card className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
                   title="The cached AI analyst read for the selected range — same engine as the Timeline tab.">
                {READ_HEADING[rangeKey]}
              </div>
              {ov.analysis && (
                <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
                  <p className="text-sm leading-relaxed m-0 max-w-4xl">{ov.analysis}</p>
                </div>
              )}
              {ov.patterns && (ov.patterns.opportunity || ov.patterns.watch) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 mt-3">
                  {ov.patterns.opportunity && (
                    <div className="border-l-2 border-foreground/20 pl-3">
                      <div className="text-xs font-medium mb-0.5 cursor-help" title="The most actionable opening in this window's numbers.">Opportunity</div>
                      <p className="text-sm text-muted-foreground leading-relaxed m-0">{ov.patterns.opportunity}</p>
                    </div>
                  )}
                  {ov.patterns.watch && (
                    <div className="border-l-2 border-foreground/20 pl-3">
                      <div className="text-xs font-medium mb-0.5 cursor-help" title="The metric or pattern most likely to change your read next.">Worth watching</div>
                      <p className="text-sm text-muted-foreground leading-relaxed m-0">{ov.patterns.watch}</p>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* needs attention: deterministic callouts linking to evidence */}
          {ov.attention.length > 0 && (
            <Card className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1"
                   title="Auto-picked from this window's measurements: friction hotspots, spikes, source shifts, segment activity. Every row links to its evidence.">
                Needs attention
              </div>
              <div className="flex flex-col">
                {ov.attention.map((a) => (
                  <Link key={a.kind} href={a.href}
                        className="group flex gap-3 items-baseline py-2.5 border-b last:border-b-0 hover:bg-muted/40 rounded-md px-1 -mx-1">
                    <span className={`shrink-0 w-20 text-[11px] font-medium uppercase tracking-wide ${a.hot ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground'}`}>
                      {a.kind}
                    </span>
                    <span className="flex-1 text-sm"><span className="font-medium">{a.strong}</span>{a.text}</span>
                    <span className="shrink-0 text-xs text-muted-foreground group-hover:text-foreground group-hover:underline">{a.linkLabel} →</span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {/* bottom split: noteworthy sessions | active segments */}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4 items-start">
            <Card className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1"
                   title="Recent sessions that were engaged or hit friction — the ones worth replaying, not just the newest.">
                Worth replaying
              </div>
              {ov.noteworthy.length === 0 ? (
                <p className="text-sm text-muted-foreground m-0 py-2">No analyzed engaged or friction sessions in this window yet.</p>
              ) : (
                <div className="flex flex-col">
                  {ov.noteworthy.map((s) => (
                    <Link key={s.id} href={`/sessions/${s.id}`}
                          className="flex gap-3 items-baseline py-2.5 border-b last:border-b-0 hover:bg-muted/40 rounded-md px-1 -mx-1">
                      <span className="shrink-0 w-28 text-xs text-muted-foreground tabular-nums">{fmtWhen(s.startedAt)}</span>
                      <span className="flex-1 text-sm truncate">{s.summary || 'Summary pending…'}</span>
                      {s.frustrated ? (
                        <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-400 bg-rose-500/10">friction</span>
                      ) : s.engaged ? (
                        <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-500/10">engaged</span>
                      ) : null}
                    </Link>
                  ))}
                </div>
              )}
              <Link href={`/projects/${id}/sessions`} className="inline-block mt-2 text-xs text-muted-foreground hover:text-foreground hover:underline">All sessions →</Link>
            </Card>

            <Card className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1"
                   title="Segments ranked by how many of their members visited in this window. Positions come from the full-history clustering.">
                Active segments
              </div>
              {ov.segments.length === 0 ? (
                <p className="text-sm text-muted-foreground m-0 py-2">
                  {ov.mappedTotal > 0 ? 'No mapped visitors were active in this window.' : 'Segments appear once enough visitors have AI profiles.'}
                </p>
              ) : (
                <div className="flex flex-col">
                  {ov.segments.map((s) => (
                    <div key={s.name} className="flex gap-2.5 items-center py-2 border-b last:border-b-0">
                      <span className="shrink-0 h-2.5 w-2.5 rounded-full" style={{ background: SEGMENT_PALETTE[s.colorIndex % SEGMENT_PALETTE.length] }} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">{s.name}</span>
                        {s.description && <span className="block text-xs text-muted-foreground truncate">{s.description}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        <span className="text-foreground font-semibold">{s.active}</span> / {s.size} active
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <Link href={`/projects/${id}/clusters${rangeKey === 'all' ? '' : `?range=${rangeKey}`}`}
                    className="inline-block mt-2 text-xs text-muted-foreground hover:text-foreground hover:underline">Open the cluster map →</Link>
            </Card>
          </div>
        </>
      )}
    </main>
  );
}

/** Tiny server-rendered sessions-per-slot chart; the busiest slot is
 * inked darkest. */
function MiniChart({ buckets }: { buckets: { start: number; total: number }[] }) {
  const W = 220, H = 72, GAP = 2;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const slot = W / buckets.length;
  const barW = Math.max(1, slot - GAP);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Sessions per slot in this window">
      {buckets.map((b, i) => {
        const h = Math.max(b.total > 0 ? 2 : 0, (b.total / max) * H);
        return (
          <rect key={b.start} x={i * slot} y={H - h} width={barW} height={h} rx={1}
                shapeRendering="crispEdges" fill={b.total === max ? '#18181b' : '#3f3f46'} opacity={b.total === max ? 1 : 0.85} />
        );
      })}
    </svg>
  );
}
