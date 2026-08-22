// The Overview landing page's data: one timeline fetch powers the pulse
// numbers, mini chart, and deterministic "needs attention" callouts;
// the cached analyst read/patterns, noteworthy sessions, and segment
// activity are cheap follow-up reads. No LLM work happens here.
import { sql, and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import {
  timelineBundleForProject, timelineAnalysis, TIMELINE_RANGES,
  type TimelineData, type TimelineSessionRow, type TimelinePatterns,
} from './timeline';
import { SOURCE_META } from './traffic-source';
import { clustersDataForProject, activeVisitorKeys, filterDimsByVisitors } from './user-segments';

export interface AttentionItem {
  kind: 'spike' | 'friction' | 'sources' | 'trend' | 'segments';
  hot?: boolean;
  text: string;
  strong: string;
  linkLabel: string;
  href: string;
}

export interface NoteworthySession {
  id: string;
  startedAt: Date;
  summary: string;
  engaged: boolean;
  frustrated: boolean;
}

export interface ActiveSegment { name: string; description: string; active: number; size: number; colorIndex: number }

const pathOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try { return new URL(url).pathname || '/'; } catch { return null; }
};

/** Entry page with the highest friction rate (≥5 sessions, ≥20% rate). */
export function worstFrictionEntry(rows: TimelineSessionRow[], windowStart: number, windowEnd: number):
  { path: string; rate: number; sessions: number } | null {
  const byPath = new Map<string, { n: number; bad: number }>();
  for (const r of rows) {
    const t = r.startedAt.getTime();
    if (t < windowStart || t >= windowEnd) continue;
    const p = pathOf(r.pageUrl);
    if (!p) continue;
    const e = byPath.get(p) ?? { n: 0, bad: 0 };
    e.n++;
    if (r.frustrated) e.bad++;
    byPath.set(p, e);
  }
  let best: { path: string; rate: number; sessions: number } | null = null;
  for (const [path, { n, bad }] of byPath) {
    if (n < 5) continue;
    const rate = bad / n;
    if (rate >= 0.2 && (!best || rate > best.rate)) best = { path, rate: Math.round(rate * 100), sessions: n };
  }
  return best;
}

const fmtWhen = (ms: number, hourly: boolean): string => {
  const d = new Date(ms);
  return hourly
    ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

/** Deterministic callouts, most actionable first, capped at 4. */
export function attentionItems(
  data: TimelineData,
  sessionsBasePath: string,
  timelinePath: string,
  clustersPath: string,
  rangeKey: string,
  frictionEntry: ReturnType<typeof worstFrictionEntry>,
  topSegment: ActiveSegment | null,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const hourly = data.bucketMs < 86_400_000;

  if (frictionEntry) {
    items.push({
      kind: 'friction', hot: true,
      strong: `${frictionEntry.path} is the roughest entry page`,
      text: ` — ${frictionEntry.rate}% of its ${frictionEntry.sessions} sessions hit friction.`,
      linkLabel: 'View sessions', href: sessionsBasePath,
    });
  }

  const spike = data.buckets.reduce<typeof data.buckets[number] | null>(
    (best, b) => (b.spike && (!best || b.spike.factor > best.spike!.factor) ? b : best), null);
  if (spike?.spike) {
    const from = new Date(spike.start).toISOString();
    const to = new Date(spike.start + data.bucketMs).toISOString();
    items.push({
      kind: 'spike',
      strong: `${fmtWhen(spike.start, hourly)} ran ${spike.spike.factor}× normal volume`,
      text: ` — ${spike.total} sessions, mostly ${SOURCE_META[spike.spike.dominant].label}.`,
      linkLabel: hourly ? 'View hour' : 'View day',
      href: `${sessionsBasePath}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&range=all`,
    });
  }

  const fru = data.trends.find((t) => t.label === 'Frustration');
  if (fru?.direction === 'up') {
    items.push({
      kind: 'trend', hot: true,
      strong: `Frustration climbed to ${fru.value}`,
      text: ' of sessions, up on the previous period.',
      linkLabel: 'View timeline', href: timelinePath,
    });
  }

  const emerging = data.trends.find((t) => t.label === 'Emerging source');
  if (emerging) {
    items.push({
      kind: 'sources',
      strong: `${emerging.value} share`,
      text: ' vs the previous period — check campaign state.',
      linkLabel: 'View timeline', href: timelinePath,
    });
  }

  if (topSegment && topSegment.active > 0) {
    items.push({
      kind: 'segments',
      strong: `“${topSegment.name}” is your most active segment`,
      text: ` — ${topSegment.active} of ${topSegment.size} members visited.`,
      linkLabel: 'View cluster',
      href: rangeKey === 'all' ? clustersPath : `${clustersPath}?range=${rangeKey}`,
    });
  }

  return items.slice(0, 4);
}

export interface OverviewData {
  data: TimelineData;
  analysis: string;
  patterns: TimelinePatterns | null;
  attention: AttentionItem[];
  noteworthy: NoteworthySession[];
  segments: ActiveSegment[];
  mappedTotal: number;
}

export async function overviewForProject(projectId: string, rangeKey: string): Promise<OverviewData> {
  const key = TIMELINE_RANGES[rangeKey] ? rangeKey : '7d';
  const base = `/projects/${projectId}`;

  const [{ data, rows }, { analysis, patterns }, allDims] = await Promise.all([
    timelineBundleForProject(projectId, key),
    timelineAnalysis(projectId, key),
    clustersDataForProject(projectId),
  ]);

  // Segment activity in the window: clustering stays global, activity
  // filters it — same rule as the Clusters page.
  const overallAll = allDims.find((d) => d.dimension === 'overall');
  let segments: ActiveSegment[] = [];
  if (overallAll) {
    const dims = key === 'all'
      ? allDims
      : filterDimsByVisitors(allDims, await activeVisitorKeys(projectId, new Date(data.windowStart)));
    const overallActive = dims.find((d) => d.dimension === 'overall');
    segments = overallAll.segments.map((s, i) => ({
      name: s.name,
      description: s.description,
      size: s.size,
      active: overallActive?.segments.find((a) => a.id === s.id)?.size ?? 0,
      colorIndex: i,
    })).filter((s) => s.active > 0)
      .sort((a, b) => b.active - a.active)
      .slice(0, 5);
  }

  // Noteworthy: recent sessions that were engaged or hit friction, with
  // a finished AI summary to show.
  interface NRow extends Record<string, unknown> {
    id: string; started_at: string; duration_ms: number | null; intent_text: string | null;
    narrative: string; frustrated: boolean;
  }
  const fromIso = new Date(data.windowStart).toISOString();
  const res = await db.execute<NRow>(sql`
    SELECT s.id, s.started_at, s.duration_ms, ss.intent_text, ss.narrative,
           jsonb_array_length(ss.insights) > 0 AS frustrated
    FROM ${schema.sessions} s
    JOIN ${schema.sessionSummaries} ss ON ss.session_id = s.id AND ss.status = 'done'
    WHERE s.project_id = ${projectId} AND s.event_count > 0
      AND s.started_at >= ${fromIso}::timestamptz
      AND (s.duration_ms >= 30000 OR jsonb_array_length(ss.insights) > 0)
    ORDER BY s.started_at DESC
    LIMIT 5
  `);
  const nRows: NRow[] = Array.isArray(res) ? res : (res as unknown as { rows: NRow[] }).rows ?? [];
  const noteworthy: NoteworthySession[] = nRows.map((r) => ({
    id: r.id,
    startedAt: new Date(r.started_at),
    summary: (r.intent_text || r.narrative || '').trim(),
    engaged: (r.duration_ms ?? 0) >= 30_000,
    frustrated: r.frustrated,
  }));

  const friction = worstFrictionEntry(rows, data.windowStart, data.windowEnd);
  const attention = attentionItems(
    data, `${base}/sessions`, `${base}/timeline`, `${base}/clusters`,
    key, friction, segments[0] ?? null,
  );

  return {
    data, analysis, patterns, attention, noteworthy, segments,
    mappedTotal: overallAll?.points.length ?? 0,
  };
}
