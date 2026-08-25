import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { sql, count, avg, sum, gt, and, eq, asc } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { getAppSettings } from '@/lib/app-settings';
import { infraStats } from '@/lib/infra-stats';
import { SettingsToggles } from '@/components/settings-toggles';
import { DataSettings } from '@/components/data-settings';
import { TeamCard } from '@/components/team-card';
import { Card } from '@/components/ui/card';
import { HeaderRule } from '@/components/header-rule';

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function fmtDuration(ms: number): string {
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

export default async function ProjectSettingsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const settings = await getAppSettings(session.orgId);
  const infra = await infraStats();

  const teamRows = await db.select({
    id: schema.adminUsers.id,
    email: schema.adminUsers.email,
    name: schema.adminUsers.name,
    role: schema.adminUsers.role,
    active: schema.adminUsers.active,
    lastLoginAt: schema.adminUsers.lastLoginAt,
  }).from(schema.adminUsers).orderBy(asc(schema.adminUsers.createdAt));
  const team = teamRows.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null }));

  const [[totals], [last24h], [summaryStats], insightRows] = await Promise.all([
    db.select({
      sessions: count(),
      avgDuration: avg(schema.sessions.durationMs),
      storage: sum(schema.sessions.blobBytes),
    }).from(schema.sessions).where(gt(schema.sessions.eventCount, 0)),
    db.select({ value: count() }).from(schema.sessions)
      .where(and(gt(schema.sessions.eventCount, 0), sql`${schema.sessions.startedAt} > now() - interval '24 hours'`)),
    db.select({
      done: count(sql`CASE WHEN ${schema.sessionSummaries.status} = 'done' THEN 1 END`),
      pending: count(sql`CASE WHEN ${schema.sessionSummaries.status} IN ('pending','processing') THEN 1 END`),
      failed: count(sql`CASE WHEN ${schema.sessionSummaries.status} = 'failed' THEN 1 END`),
      withIntent: count(schema.sessionSummaries.intentText),
    }).from(schema.sessionSummaries),
    db.execute<{ kind: string; total: string }>(sql`
      SELECT i->>'kind' AS kind, count(*) AS total
      FROM ${schema.sessionSummaries}, jsonb_array_elements(insights) AS i
      GROUP BY 1 ORDER BY 2 DESC
    `),
  ]);
  const insights: { kind: string; total: string }[] = Array.isArray(insightRows)
    ? insightRows
    : (insightRows as unknown as { rows: { kind: string; total: string }[] }).rows ?? [];

  const stats = [
    { label: 'Recorded sessions', value: totals.sessions.toLocaleString() },
    { label: 'Sessions (24h)', value: last24h.value.toLocaleString() },
    { label: 'Avg duration', value: totals.avgDuration ? fmtDuration(Number(totals.avgDuration)) : '—' },
    { label: 'Storage used', value: fmtBytes(Number(totals.storage ?? 0)) },
    { label: 'AI summaries done', value: summaryStats.done.toLocaleString() },
    { label: 'Summaries queued', value: summaryStats.pending.toLocaleString() },
  ];

  // Anchor nav — the page has grown enough sections to need a map.
  const SECTIONS = [
    ['recording', 'Recording'],
    ['ai', 'AI features'],
    ['team', 'Team'],
    ['stats', 'Stats'],
    ['infra', 'Infra'],
  ] as const;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Settings</h1>
          <p className="text-sm text-muted-foreground">Feature toggles apply within a minute — no redeploy needed.</p>
        </div>
        <nav className="flex gap-3 text-sm text-muted-foreground whitespace-nowrap">
          {SECTIONS.map(([anchor, label]) => (
            <a key={anchor} href={`#${anchor}`} className="hover:text-foreground hover:underline">{label}</a>
          ))}
        </nav>
      </div>

      <HeaderRule />

      <section id="recording" className="scroll-mt-6">
        <h2 className="font-semibold mb-2">Recording &amp; data</h2>
        <p className="text-sm text-muted-foreground mb-2">
          Replays age out with retention; timeline history, profiles, and segments are kept.
        </p>
        <DataSettings
          projectId={project.id}
          initialRetentionDays={project.retentionDays}
          initialMaxSessionMinutes={project.maxSessionMinutes}
        />
      </section>

      <section id="ai" className="scroll-mt-6">
        <h2 className="font-semibold mb-2">AI features</h2>
        <p className="text-sm text-muted-foreground mb-2">
          What the LLM layer works on. Turning a stage off pauses new work; nothing already computed is lost.
        </p>
        <SettingsToggles initial={settings} />
      </section>

      <section id="team" className="scroll-mt-6">
        <h2 className="font-semibold mb-2">Team</h2>
        <p className="text-sm text-muted-foreground mb-2">
          Who can sign in to this dashboard. Owners manage the team; members see everything else.
        </p>
        <TeamCard initialUsers={team} meId={session.userId} canManage={session.userRole === 'owner'} />
      </section>

      <section id="stats" className="scroll-mt-6">
        <h2 className="font-semibold mb-2">General stats</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {stats.map((s) => (
            <Card key={s.label} className="p-4">
              <div className="text-2xl font-semibold">{s.value}</div>
              <div className="text-sm text-muted-foreground">{s.label}</div>
            </Card>
          ))}
        </div>

        {insights.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold mb-2">Frustration signals (all time)</h3>
          <Card className="divide-y p-0">
            {insights.map((i) => (
              <div key={i.kind} className="flex items-center justify-between p-3 text-sm">
                <span>{INSIGHT_LABELS[i.kind] ?? i.kind}</span>
                <span className="font-medium">{Number(i.total).toLocaleString()}</span>
              </div>
            ))}
          </Card>
          </div>
        )}
      </section>

      <section id="infra" className="scroll-mt-6">
        <h2 className="font-semibold mb-2">Infra</h2>
        <p className="text-sm text-muted-foreground mb-2">
          Early-warning gauges: watch these before users feel anything.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Card className="p-4" title="AI analysis waiting to run. Growing steadily means the LLM service is falling behind the traffic.">
            <div className="text-2xl font-semibold tabular-nums">{infra.summaries.pending + infra.summaries.processing}</div>
            <div className="text-sm text-muted-foreground">Summary backlog</div>
            {infra.summaries.failed > 0 && <div className="text-xs text-rose-600 mt-1">{infra.summaries.failed} failed</div>}
          </Card>
          <Card className="p-4" title="Median time from session capture to finished AI summary, last 24 hours.">
            <div className="text-2xl font-semibold tabular-nums">{infra.medianLatencyMs === null ? '—' : fmtDuration(infra.medianLatencyMs)}</div>
            <div className="text-sm text-muted-foreground">Median summary latency</div>
          </Card>
          <Card className="p-4" title="Total Postgres size — replay blobs are the main consumer; retention keeps this bounded.">
            <div className="text-2xl font-semibold tabular-nums">{fmtBytes(infra.dbBytes)}</div>
            <div className="text-sm text-muted-foreground">Database size</div>
            <div className="text-xs text-muted-foreground mt-1">{fmtBytes(infra.sessionsBytes)} sessions table (incl. replays)</div>
          </Card>
          <Card className="p-4" title="Redis-backed job queues (BullMQ). Off means the built-in in-process loops are running instead.">
            <div className="text-2xl font-semibold">{infra.queuesEnabled ? (infra.queues ? 'on' : 'error') : 'off'}</div>
            <div className="text-sm text-muted-foreground">Job queues (Redis)</div>
            {infra.queues && (
              <div className="text-xs text-muted-foreground mt-1 tabular-nums">
                {(Object.entries(infra.queues) as [string, { waiting: number; active: number }][])
                  .map(([n, c]) => `${n} ${c.waiting + c.active}`).join(' · ')}
              </div>
            )}
          </Card>
          <Card className="p-4" title="Pre-aggregated hourly timeline rollups. The freshest hour should track the current hour once backfill completes.">
            <div className="text-2xl font-semibold tabular-nums">{infra.rollups.count.toLocaleString()}</div>
            <div className="text-sm text-muted-foreground">Timeline rollup hours</div>
            <div className="text-xs text-muted-foreground mt-1">
              {infra.rollups.freshestHour
                ? `fresh to ${infra.rollups.freshestHour.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`
                : 'not built yet'}
            </div>
          </Card>
          <Card className="p-4" title="Live /health check of the private multimodel LLM service (LLM_SERVICE_URL).">
            <div className={`text-2xl font-semibold ${infra.llm === 'unreachable' ? 'text-rose-600' : ''}`}>{infra.llm}</div>
            <div className="text-sm text-muted-foreground">LLM service</div>
          </Card>
          <Card className="p-4" title="Live workers holding the clustering queue — the standalone cluster service. 0 means it is down or disconnected from Redis.">
            <div className={`text-2xl font-semibold ${infra.clusterWorkers === 0 ? 'text-rose-600' : ''}`}>
              {infra.clusterWorkers === null ? '—' : infra.clusterWorkers > 0 ? 'connected' : 'no worker'}
            </div>
            <div className="text-sm text-muted-foreground">Cluster service</div>
            {infra.clusterWorkers !== null && infra.clusterWorkers > 0 && (
              <div className="text-xs text-muted-foreground mt-1 tabular-nums">{infra.clusterWorkers} worker{infra.clusterWorkers === 1 ? '' : 's'} on the clustering queue</div>
            )}
            {infra.clusterWorkers === null && (
              <div className="text-xs text-muted-foreground mt-1">runs in-process without Redis</div>
            )}
          </Card>
        </div>
      </section>
    </main>
  );
}
