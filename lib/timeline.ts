// Timeline: sessions over time, bucketed and colored by traffic source,
// with deterministic trend detection (current window vs the previous
// equal window) and spike annotation. All math is pure and computed at
// request time from one indexed query; only the analyst read is an LLM
// product, cached in timeline_analyses by a background cycle.
import { sql, and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { categorizeSource, SOURCE_CATEGORIES, SOURCE_META, type SourceCategory } from './traffic-source';

export const TIMELINE_RANGES: Record<string, { windowMs: number; bucketMs: number; label: string }> = {
  '24h': { windowMs: 24 * 3600_000, bucketMs: 3600_000, label: 'last 24 hours' },
  '7d': { windowMs: 7 * 86_400_000, bucketMs: 86_400_000, label: 'last 7 days' },
  '30d': { windowMs: 30 * 86_400_000, bucketMs: 86_400_000, label: 'last 30 days' },
};
export const DEFAULT_RANGE = '7d';
const ENGAGED_MS = 30_000;
const SPIKE_Z = 2;
const EMERGING_SHARE_PTS = 8;

export interface TimelineSessionRow {
  startedAt: Date;
  durationMs: number | null;
  referrer: string | null;
  pageUrl: string | null;
  visitorKey: string;
  firstSeenAt: Date;
  frustrated: boolean;
}

export interface TimelineBucket {
  start: number;
  bySource: Record<SourceCategory, number>;
  total: number;
  spike?: { factor: number; dominant: SourceCategory };
}

export interface TrendChip { label: string; value: string; direction: 'up' | 'down' | 'flat' }

export interface TimelineData {
  buckets: TimelineBucket[];
  totals: { sessions: number; engaged: number; frustrated: number; newVisitors: number; bySource: Record<SourceCategory, number> };
  trends: TrendChip[];
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
}

function emptySources(): Record<SourceCategory, number> {
  return Object.fromEntries(SOURCE_CATEGORIES.map((s) => [s, 0])) as Record<SourceCategory, number>;
}

function windowStats(rows: TimelineSessionRow[], start: number, end: number) {
  const inWindow = rows.filter((r) => r.startedAt.getTime() >= start && r.startedAt.getTime() < end);
  const bySource = emptySources();
  let engaged = 0, frustrated = 0;
  const newVisitors = new Set<string>();
  for (const r of inWindow) {
    bySource[categorizeSource(r.referrer, r.pageUrl)]++;
    if ((r.durationMs ?? 0) >= ENGAGED_MS) engaged++;
    if (r.frustrated) frustrated++;
    if (r.firstSeenAt.getTime() >= start) newVisitors.add(r.visitorKey);
  }
  return { sessions: inWindow.length, engaged, frustrated, newVisitors: newVisitors.size, bySource };
}

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const fmtDelta = (cur: number, prev: number): { value: string; direction: 'up' | 'down' | 'flat' } => {
  if (prev === 0) return cur > 0 ? { value: 'new', direction: 'up' } : { value: '±0%', direction: 'flat' };
  const d = Math.round(((cur - prev) / prev) * 100);
  return { value: `${d > 0 ? '+' : ''}${d}%`, direction: d > 2 ? 'up' : d < -2 ? 'down' : 'flat' };
};

/** Pure assembly: buckets + totals + period-over-period trends + spikes. */
export function buildTimeline(rows: TimelineSessionRow[], windowEnd: number, windowMs: number, bucketMs: number): TimelineData {
  const windowStart = windowEnd - windowMs;
  const prevStart = windowStart - windowMs;

  const bucketCount = Math.ceil(windowMs / bucketMs);
  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: windowStart + i * bucketMs,
    bySource: emptySources(),
    total: 0,
  }));
  for (const r of rows) {
    const t = r.startedAt.getTime();
    if (t < windowStart || t >= windowEnd) continue;
    const b = buckets[Math.min(bucketCount - 1, Math.floor((t - windowStart) / bucketMs))];
    b.bySource[categorizeSource(r.referrer, r.pageUrl)]++;
    b.total++;
  }

  // Spikes: buckets deviating hard from the window's own rhythm.
  const totalsArr = buckets.map((b) => b.total);
  const mean = totalsArr.reduce((a, b) => a + b, 0) / Math.max(1, totalsArr.length);
  const sd = Math.sqrt(totalsArr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, totalsArr.length));
  for (const b of buckets) {
    if (sd > 0 && b.total >= 3 && (b.total - mean) / sd >= SPIKE_Z) {
      const dominant = SOURCE_CATEGORIES.reduce((best, s) => (b.bySource[s] > b.bySource[best] ? s : best), SOURCE_CATEGORIES[0]);
      b.spike = { factor: Math.round((b.total / Math.max(0.5, mean)) * 10) / 10, dominant };
    }
  }

  const cur = windowStats(rows, windowStart, windowEnd);
  const prev = windowStats(rows, prevStart, windowStart);

  const trends: TrendChip[] = [];
  const sessionsDelta = fmtDelta(cur.sessions, prev.sessions);
  trends.push({ label: 'Sessions', value: `${cur.sessions} (${sessionsDelta.value})`, direction: sessionsDelta.direction });
  const engRate = pct(cur.engaged, cur.sessions);
  const engPrev = pct(prev.engaged, prev.sessions);
  trends.push({ label: 'Engaged (30s+)', value: `${Math.round(engRate)}%`, direction: engRate > engPrev + 2 ? 'up' : engRate < engPrev - 2 ? 'down' : 'flat' });
  const fruRate = pct(cur.frustrated, cur.sessions);
  const fruPrev = pct(prev.frustrated, prev.sessions);
  trends.push({ label: 'Frustration', value: `${Math.round(fruRate)}%`, direction: fruRate > fruPrev + 2 ? 'up' : fruRate < fruPrev - 2 ? 'down' : 'flat' });
  trends.push({ label: 'New visitors', value: `${Math.round(pct(cur.newVisitors, Math.max(1, cur.sessions)))}%`, direction: 'flat' });
  // Emerging source: biggest share-point gain vs the previous window.
  let emerging: { s: SourceCategory; gain: number } | null = null;
  for (const s of SOURCE_CATEGORIES) {
    const gain = pct(cur.bySource[s], cur.sessions) - pct(prev.bySource[s], prev.sessions);
    if (cur.bySource[s] >= 3 && gain >= EMERGING_SHARE_PTS && (!emerging || gain > emerging.gain)) emerging = { s, gain };
  }
  if (emerging) {
    trends.push({ label: 'Emerging source', value: `${SOURCE_META[emerging.s].label} +${Math.round(emerging.gain)}pts`, direction: 'up' });
  }

  return { buckets, totals: cur, trends, windowStart, windowEnd, bucketMs };
}

/** Fetch rows covering current + previous window in one query. */
export async function timelineRowsForProject(projectId: string, windowEnd: number, windowMs: number): Promise<TimelineSessionRow[]> {
  const fetchStart = new Date(windowEnd - 2 * windowMs);
  interface Row extends Record<string, unknown> {
    started_at: string; duration_ms: number | null; referrer: string | null; page_url: string | null;
    visitor_key: string; first_seen_at: string; frustrated: boolean;
  }
  const res = await db.execute<Row>(sql`
    SELECT s.started_at, s.duration_ms, s.referrer, s.page_url,
           coalesce(s.user_id, s.anon_id) AS visitor_key,
           first_seen.at AS first_seen_at,
           EXISTS (
             SELECT 1 FROM ${schema.sessionSummaries} ss
             WHERE ss.session_id = s.id AND jsonb_array_length(ss.insights) > 0
           ) AS frustrated
    FROM ${schema.sessions} s
    JOIN LATERAL (
      SELECT min(s2.started_at) AS at FROM ${schema.sessions} s2
      WHERE s2.project_id = s.project_id AND coalesce(s2.user_id, s2.anon_id) = coalesce(s.user_id, s.anon_id)
    ) first_seen ON true
    WHERE s.project_id = ${projectId} AND s.event_count > 0 AND s.started_at >= ${fetchStart}
  `);
  const rows: Row[] = Array.isArray(res) ? res : (res as unknown as { rows: Row[] }).rows ?? [];
  return rows.map((r) => ({
    startedAt: new Date(r.started_at),
    durationMs: r.duration_ms,
    referrer: r.referrer,
    pageUrl: r.page_url,
    visitorKey: r.visitor_key,
    firstSeenAt: new Date(r.first_seen_at),
    frustrated: r.frustrated,
  }));
}

export async function timelineForProject(projectId: string, rangeKey: string): Promise<TimelineData> {
  const range = TIMELINE_RANGES[rangeKey] ?? TIMELINE_RANGES[DEFAULT_RANGE];
  const windowEnd = Date.now();
  const rows = await timelineRowsForProject(projectId, windowEnd, range.windowMs);
  return buildTimeline(rows, windowEnd, range.windowMs, range.bucketMs);
}

export async function timelineAnalysis(projectId: string, rangeKey: string): Promise<string> {
  const key = TIMELINE_RANGES[rangeKey] ? rangeKey : DEFAULT_RANGE;
  const [row] = await db.select({ analysis: schema.timelineAnalyses.analysis })
    .from(schema.timelineAnalyses)
    .where(and(eq(schema.timelineAnalyses.projectId, projectId), eq(schema.timelineAnalyses.rangeKey, key)));
  return row?.analysis ?? '';
}

const ANALYSIS_STALE_MS = 6 * 3600_000;

/** Background: refresh the cached analyst read per project + range. */
export async function refreshTimelineAnalyses(fetchFn: typeof fetch = fetch): Promise<number> {
  const baseUrl = process.env.SUMMARIZER_URL;
  if (!baseUrl) return 0;
  const settings = await getAppSettings();
  if (!settings.intentEnabled) return 0;
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
  let refreshed = 0;
  for (const p of projects) {
    for (const rangeKey of Object.keys(TIMELINE_RANGES)) {
      const [existing] = await db.select({ builtAt: schema.timelineAnalyses.builtAt })
        .from(schema.timelineAnalyses)
        .where(and(eq(schema.timelineAnalyses.projectId, p.id), eq(schema.timelineAnalyses.rangeKey, rangeKey)));
      if (existing && Date.now() - existing.builtAt.getTime() < ANALYSIS_STALE_MS) continue;
      const data = await timelineForProject(p.id, rangeKey);
      if (data.totals.sessions === 0) continue;
      const input = [
        `Window: ${TIMELINE_RANGES[rangeKey].label}. Sessions: ${data.totals.sessions}; engaged(30s+): ${data.totals.engaged}; with frustration signals: ${data.totals.frustrated}; new visitors: ${data.totals.newVisitors}.`,
        `By source: ${SOURCE_CATEGORIES.map((s) => `${SOURCE_META[s].label} ${data.totals.bySource[s]}`).join(', ')}.`,
        `Trends vs previous window: ${data.trends.map((t) => `${t.label} ${t.value} (${t.direction})`).join('; ')}.`,
        ...(data.buckets.filter((b) => b.spike).slice(0, 3).map((b) =>
          `Spike at ${new Date(b.start).toISOString()}: ${b.total} sessions (${b.spike!.factor}x normal), mostly ${SOURCE_META[b.spike!.dominant].label}.`)),
      ].join('\n');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        let analysis = '';
        try {
          const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: ctrl.signal,
            body: JSON.stringify({
              messages: [
                { role: 'system', content: 'You are an expert web-traffic analyst. Given period metrics for a website, write a concise 2-3 sentence read: what changed in this window, the likely driver, and the single most useful implication. Plain text, no preamble.' },
                { role: 'user', content: input },
              ],
              max_tokens: 160,
              temperature: 0.3,
            }),
          });
          if (!res.ok) throw new Error(`summarizer ${res.status}`);
          const json = await res.json() as { choices?: { message?: { content?: string } }[] };
          analysis = json.choices?.[0]?.message?.content?.trim() ?? '';
        } finally {
          clearTimeout(timer);
        }
        if (!analysis) continue;
        await db.insert(schema.timelineAnalyses)
          .values({ projectId: p.id, rangeKey, analysis })
          .onConflictDoUpdate({
            target: [schema.timelineAnalyses.projectId, schema.timelineAnalyses.rangeKey],
            set: { analysis, builtAt: new Date() },
          });
        refreshed++;
      } catch (e) {
        console.warn('[timeline] analysis failed', p.id, rangeKey, e instanceof Error ? e.message : e);
      }
    }
  }
  return refreshed;
}

