import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { sql, count, avg, sum, gt, and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { getAppSettings } from '@/lib/app-settings';
import { SettingsToggles } from '@/components/settings-toggles';
import { Card } from '@/components/ui/card';

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

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Settings</h1>
          <p className="text-sm text-muted-foreground">Feature toggles apply within a minute — no redeploy needed.</p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <Link href={`/projects/${id}/sessions`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/users`} className="text-muted-foreground hover:underline">Users</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/clusters`} className="text-muted-foreground hover:underline">Clusters</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/tags`} className="text-muted-foreground hover:underline">Tags</Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Settings</span>
        </div>
      </div>

      <SettingsToggles initial={settings} />

      <div>
        <h2 className="font-semibold mb-2">General stats</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {stats.map((s) => (
            <Card key={s.label} className="p-4">
              <div className="text-2xl font-semibold">{s.value}</div>
              <div className="text-sm text-muted-foreground">{s.label}</div>
            </Card>
          ))}
        </div>
      </div>

      {insights.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Frustration signals (all time)</h2>
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
    </main>
  );
}
