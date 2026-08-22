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
  // Sentinel: window resolved at runtime from the first recorded session;
  // no previous-window comparison (there is no previous window).
  'all': { windowMs: 0, bucketMs: 0, label: 'full recorded history' },
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
  insightKinds?: string[];
  clicks?: number;
  tags?: { name: string; color: string }[];
}

export { TIMELINE_METRICS, type TimelineMetric } from './timeline-metrics';

export interface TimelineBucket {
  start: number;
  bySource: Record<SourceCategory, number>;
  total: number;
  clicksBySource: Record<SourceCategory, number>;
  engagedBySource: Record<SourceCategory, number>;
  frustratedBySource: Record<SourceCategory, number>;
  byTag: Record<string, number>;
  spike?: { factor: number; dominant: SourceCategory };
}

export interface TrendChip { label: string; value: string; direction: 'up' | 'down' | 'flat' }

export interface TimelineTotals {
  sessions: number;
  engaged: number;
  frustrated: number;
  newVisitors: number;
  newSessions: number;
  avgDurationMs: number;
  insightCounts: Record<string, number>;
  bySource: Record<SourceCategory, number>;
}

export interface TimelineData {
  buckets: TimelineBucket[];
  totals: TimelineTotals;
  trends: TrendChip[];
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
  /** Tag name → chart color for the by-tag stack, from the tag rules. */
  tagMeta: Record<string, { color: string }>;
}

function emptySources(): Record<SourceCategory, number> {
  return Object.fromEntries(SOURCE_CATEGORIES.map((s) => [s, 0])) as Record<SourceCategory, number>;
}

function windowStats(rows: TimelineSessionRow[], start: number, end: number): TimelineTotals {
  const inWindow = rows.filter((r) => r.startedAt.getTime() >= start && r.startedAt.getTime() < end);
  const bySource = emptySources();
  const insightCounts: Record<string, number> = {};
  let engaged = 0, frustrated = 0, newSessions = 0, durSum = 0;
  const newVisitors = new Set<string>();
  for (const r of inWindow) {
    bySource[categorizeSource(r.referrer, r.pageUrl)]++;
    if ((r.durationMs ?? 0) >= ENGAGED_MS) engaged++;
    if (r.frustrated) frustrated++;
    durSum += r.durationMs ?? 0;
    if (r.firstSeenAt.getTime() >= start) { newVisitors.add(r.visitorKey); newSessions++; }
    for (const k of r.insightKinds ?? []) insightCounts[k] = (insightCounts[k] ?? 0) + 1;
  }
  return {
    sessions: inWindow.length, engaged, frustrated,
    newVisitors: newVisitors.size, newSessions,
    avgDurationMs: inWindow.length > 0 ? durSum / inWindow.length : 0,
    insightCounts, bySource,
  };
}

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const fmtDelta = (cur: number, prev: number): { value: string; direction: 'up' | 'down' | 'flat' } => {
  if (prev === 0) return cur > 0 ? { value: 'new', direction: 'up' } : { value: '±0%', direction: 'flat' };
  const d = Math.round(((cur - prev) / prev) * 100);
  return { value: `${d > 0 ? '+' : ''}${d}%`, direction: d > 2 ? 'up' : d < -2 ? 'down' : 'flat' };
};

/** Pure assembly: buckets + totals + period-over-period trends + spikes.
 * With comparePrevious=false (all-time), chips carry plain totals.
 * The window start is aligned down to a bucket boundary (UTC) so a
 * daily bar covers a real calendar day, not a now-anchored slice —
 * otherwise the "19 Aug" bar would never match the 19 Aug sessions. */
export function buildTimeline(rows: TimelineSessionRow[], windowEnd: number, windowMs: number, bucketMs: number, comparePrevious = true): TimelineData {
  const windowStart = Math.floor((windowEnd - windowMs) / bucketMs) * bucketMs;
  const realWindowMs = windowEnd - windowStart;
  const prevStart = windowStart - realWindowMs;

  const bucketCount = Math.ceil(realWindowMs / bucketMs);
  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: windowStart + i * bucketMs,
    bySource: emptySources(),
    total: 0,
    clicksBySource: emptySources(),
    engagedBySource: emptySources(),
    frustratedBySource: emptySources(),
    byTag: {},
  }));
  const tagMeta: Record<string, { color: string }> = {};
  for (const r of rows) {
    const t = r.startedAt.getTime();
    if (t < windowStart || t >= windowEnd) continue;
    const b = buckets[Math.min(bucketCount - 1, Math.floor((t - windowStart) / bucketMs))];
    const src = categorizeSource(r.referrer, r.pageUrl);
    b.bySource[src]++;
    b.total++;
    b.clicksBySource[src] += r.clicks ?? 0;
    if ((r.durationMs ?? 0) >= ENGAGED_MS) b.engagedBySource[src]++;
    if (r.frustrated) b.frustratedBySource[src]++;
    for (const tag of r.tags ?? []) {
      b.byTag[tag.name] = (b.byTag[tag.name] ?? 0) + 1;
      tagMeta[tag.name] ??= { color: tag.color };
    }
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
  if (comparePrevious) {
    const sessionsDelta = fmtDelta(cur.sessions, prev.sessions);
    trends.push({ label: 'Sessions', value: `${cur.sessions} (${sessionsDelta.value})`, direction: sessionsDelta.direction });
  } else {
    trends.push({ label: 'Sessions', value: `${cur.sessions}`, direction: 'flat' });
  }
  const engRate = pct(cur.engaged, cur.sessions);
  const engPrev = pct(prev.engaged, prev.sessions);
  trends.push({ label: 'Engaged (30s+)', value: `${Math.round(engRate)}%`, direction: comparePrevious && engRate > engPrev + 2 ? 'up' : comparePrevious && engRate < engPrev - 2 ? 'down' : 'flat' });
  const fruRate = pct(cur.frustrated, cur.sessions);
  const fruPrev = pct(prev.frustrated, prev.sessions);
  trends.push({ label: 'Frustration', value: `${Math.round(fruRate)}%`, direction: comparePrevious && fruRate > fruPrev + 2 ? 'up' : comparePrevious && fruRate < fruPrev - 2 ? 'down' : 'flat' });
  // Share of *sessions* from first-time visitors — matches the
  // new-vs-returning split, not the distinct-visitor count.
  trends.push({ label: 'New visitors', value: `${Math.round(pct(cur.newSessions, Math.max(1, cur.sessions)))}%`, direction: 'flat' });
  if (comparePrevious) {
    // Emerging source: biggest share-point gain vs the previous window.
    let emerging: { s: SourceCategory; gain: number } | null = null;
    for (const s of SOURCE_CATEGORIES) {
      const gain = pct(cur.bySource[s], cur.sessions) - pct(prev.bySource[s], prev.sessions);
      if (cur.bySource[s] >= 3 && gain >= EMERGING_SHARE_PTS && (!emerging || gain > emerging.gain)) emerging = { s, gain };
    }
    if (emerging) {
      trends.push({ label: 'Emerging source', value: `${SOURCE_META[emerging.s].label} +${Math.round(emerging.gain)}pts`, direction: 'up' });
    }
  }

  return { buckets, totals: cur, trends, windowStart, windowEnd, bucketMs, tagMeta };
}

/** Fetch rows covering current + previous window in one query. */
export async function timelineRowsForProject(projectId: string, windowEnd: number, windowMs: number): Promise<TimelineSessionRow[]> {
  // Raw-SQL params must be primitives — a JS Date fails serialization.
  const fetchStart = new Date(windowEnd - 2 * windowMs).toISOString();
  interface Row extends Record<string, unknown> {
    started_at: string; duration_ms: number | null; referrer: string | null; page_url: string | null;
    visitor_key: string; first_seen_at: string; frustrated: boolean; insights: { kind?: string }[] | null;
    clicks: number; tags: { name: string; color: string }[] | null;
  }
  const res = await db.execute<Row>(sql`
    SELECT s.started_at, s.duration_ms, s.referrer, s.page_url,
           coalesce(s.user_id, s.anon_id) AS visitor_key,
           first_seen.at AS first_seen_at,
           EXISTS (
             SELECT 1 FROM ${schema.sessionSummaries} ss
             WHERE ss.session_id = s.id AND jsonb_array_length(ss.insights) > 0
           ) AS frustrated,
           (SELECT ss2.insights FROM ${schema.sessionSummaries} ss2 WHERE ss2.session_id = s.id LIMIT 1) AS insights,
           coalesce((
             SELECT count(*)::int FROM ${schema.sessionSummaries} ss3,
                    jsonb_array_elements(ss3.digest->'steps') step
             WHERE ss3.session_id = s.id AND step->>'kind' = 'click'
           ), 0) AS clicks,
           (SELECT jsonb_agg(jsonb_build_object('name', tr.name, 'color', tr.color))
            FROM ${schema.sessionTags} st
            JOIN ${schema.tagRules} tr ON tr.id = st.tag_rule_id
            WHERE st.session_id = s.id) AS tags
    FROM ${schema.sessions} s
    JOIN LATERAL (
      SELECT min(s2.started_at) AS at FROM ${schema.sessions} s2
      WHERE s2.project_id = s.project_id AND coalesce(s2.user_id, s2.anon_id) = coalesce(s.user_id, s.anon_id)
    ) first_seen ON true
    WHERE s.project_id = ${projectId} AND s.event_count > 0 AND s.started_at >= ${fetchStart}::timestamptz
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
    insightKinds: (r.insights ?? []).map((i) => i.kind).filter((k): k is string => Boolean(k)),
    clicks: r.clicks,
    tags: r.tags ?? [],
  }));
}

export async function timelineForProject(projectId: string, rangeKey: string): Promise<TimelineData> {
  const windowEnd = Date.now();
  if (rangeKey === 'all') {
    // Sessions carry client-supplied clocks, and one skewed timestamp
    // (seen: 1978) would otherwise stretch "all time" across decades of
    // empty buckets — so the earliest session that predates the project
    // itself can't anchor the window.
    interface MinRow extends Record<string, unknown> { min: string | null }
    const res = await db.execute<MinRow>(sql`
      SELECT min(s.started_at) AS min
      FROM ${schema.sessions} s
      WHERE s.project_id = ${projectId} AND s.event_count > 0
        AND s.started_at >= (SELECT p.created_at FROM ${schema.projects} p WHERE p.id = ${projectId})
    `);
    const rows0: MinRow[] = Array.isArray(res) ? res : (res as unknown as { rows: MinRow[] }).rows ?? [];
    const start = rows0[0]?.min ? new Date(rows0[0].min).getTime() : windowEnd - 86_400_000;
    const windowMs = Math.max(86_400_000, windowEnd - start);
    const bucketMs = windowMs <= 2 * 86_400_000 ? 3600_000 : windowMs <= 90 * 86_400_000 ? 86_400_000 : 7 * 86_400_000;
    // +bucketMs: bucket alignment can pull the window start earlier.
    const rows = await timelineRowsForProject(projectId, windowEnd, windowMs + bucketMs);
    return buildTimeline(rows, windowEnd, windowMs, bucketMs, false);
  }
  const range = TIMELINE_RANGES[rangeKey] ?? TIMELINE_RANGES[DEFAULT_RANGE];
  const rows = await timelineRowsForProject(projectId, windowEnd, range.windowMs + range.bucketMs);
  return buildTimeline(rows, windowEnd, range.windowMs, range.bucketMs);
}

export interface TimelinePatterns { peaks: string; quiet: string; opportunity: string; watch: string }

const fmtBucketTime = (ms: number, hourly: boolean): string => {
  const d = new Date(ms);
  return hourly
    ? d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
};

/** Deterministic aggregates the pattern analyst reasons over: peak
 * buckets, the longest quiet stretch, day/hour rhythm, mix and rates. */
export function buildPatternInput(data: TimelineData): string {
  const { buckets, totals, bucketMs } = data;
  const hourly = bucketMs < 86_400_000;
  const unit = hourly ? 'hour' : bucketMs >= 7 * 86_400_000 ? 'week' : 'day';
  const mean = totals.sessions / Math.max(1, buckets.length);
  const lines: string[] = [];

  const top = [...buckets].filter((b) => b.total > 0).sort((a, b) => b.total - a.total).slice(0, 3);
  if (top.length > 0) {
    lines.push(`Busiest ${unit}s: ${top.map((b) => `${fmtBucketTime(b.start, hourly)} (${b.total} sessions)`).join(', ')}.`);
  }

  // Longest run of near-dead buckets (≤ 25% of the window's mean).
  const threshold = mean * 0.25;
  let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
  buckets.forEach((b, i) => {
    if (b.total <= threshold) {
      if (runLen === 0) runStart = i;
      runLen++;
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
    } else runLen = 0;
  });
  if (bestLen >= 2) {
    const from = fmtBucketTime(buckets[bestStart].start, hourly);
    const to = fmtBucketTime(buckets[bestStart + bestLen - 1].start + bucketMs, hourly);
    lines.push(`Quietest stretch: ${bestLen} ${unit}s nearly dead (${from} to ${to}).`);
  }

  // Rhythm: average sessions per hour-of-day (hourly buckets) or per
  // weekday (daily buckets) — the shape recurring traffic follows.
  if (unit !== 'week' && buckets.length >= (hourly ? 24 : 7)) {
    const sums = new Map<string, { n: number; c: number }>();
    for (const b of buckets) {
      const d = new Date(b.start);
      const key = hourly ? `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC` : d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const e = sums.get(key) ?? { n: 0, c: 0 };
      e.n += b.total; e.c++;
      sums.set(key, e);
    }
    const avgs = [...sums.entries()].map(([k, v]) => [k, v.n / v.c] as const).sort((a, b) => b[1] - a[1]);
    if (avgs.length >= 3 && avgs[0][1] > 0) {
      lines.push(`Typical rhythm: strongest around ${avgs[0][0]} (avg ${avgs[0][1].toFixed(1)}/${unit}), weakest around ${avgs[avgs.length - 1][0]} (avg ${avgs[avgs.length - 1][1].toFixed(1)}/${unit}).`);
    }
  }

  lines.push(`Totals: ${totals.sessions} sessions; ${Math.round(pct(totals.engaged, totals.sessions))}% engaged 30s+; avg duration ${Math.round(totals.avgDurationMs / 1000)}s; ${Math.round(pct(totals.newSessions, totals.sessions))}% from new visitors.`);
  const srcs = SOURCE_CATEGORIES.filter((s) => totals.bySource[s] > 0)
    .sort((a, b) => totals.bySource[b] - totals.bySource[a])
    .map((s) => `${SOURCE_META[s].label} ${Math.round(pct(totals.bySource[s], totals.sessions))}%`);
  if (srcs.length > 0) lines.push(`Sources: ${srcs.join(', ')}.`);
  const fric = Object.entries(totals.insightCounts).sort(([, a], [, b]) => b - a).slice(0, 3)
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`);
  if (fric.length > 0) lines.push(`Top friction: ${fric.join(', ')}.`);
  return lines.join('\n');
}

const PATTERN_LABELS = ['Peaks', 'Quiet', 'Opportunity', 'Watch'] as const;

/** Parse the analyst's 4 labeled lines; null when fewer than 3 landed. */
export function parsePatterns(text: string): TimelinePatterns | null {
  const out: Record<string, string> = {};
  for (const label of PATTERN_LABELS) {
    const m = text.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'mi'));
    if (m) out[label.toLowerCase()] = m[1].replace(/\*+/g, '').trim();
  }
  if (Object.keys(out).length < 3) return null;
  return {
    peaks: out.peaks ?? '', quiet: out.quiet ?? '',
    opportunity: out.opportunity ?? '', watch: out.watch ?? '',
  };
}

export async function timelineAnalysis(projectId: string, rangeKey: string): Promise<{ analysis: string; patterns: TimelinePatterns | null }> {
  const key = TIMELINE_RANGES[rangeKey] ? rangeKey : DEFAULT_RANGE;
  const [row] = await db.select({ analysis: schema.timelineAnalyses.analysis, patterns: schema.timelineAnalyses.patterns })
    .from(schema.timelineAnalyses)
    .where(and(eq(schema.timelineAnalyses.projectId, projectId), eq(schema.timelineAnalyses.rangeKey, key)));
  return { analysis: row?.analysis ?? '', patterns: (row?.patterns as TimelinePatterns | null) ?? null };
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
      const [existing] = await db.select({ builtAt: schema.timelineAnalyses.builtAt, patterns: schema.timelineAnalyses.patterns })
        .from(schema.timelineAnalyses)
        .where(and(eq(schema.timelineAnalyses.projectId, p.id), eq(schema.timelineAnalyses.rangeKey, rangeKey)));
      if (existing && existing.patterns !== null && Date.now() - existing.builtAt.getTime() < ANALYSIS_STALE_MS) continue;
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
        const chat = async (system: string, user: string, maxTokens: number): Promise<string> => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60_000);
          try {
            const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              signal: ctrl.signal,
              body: JSON.stringify({
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                max_tokens: maxTokens,
                temperature: 0.3,
              }),
            });
            if (!res.ok) throw new Error(`summarizer ${res.status}`);
            const json = await res.json() as { choices?: { message?: { content?: string } }[] };
            return json.choices?.[0]?.message?.content?.trim() ?? '';
          } finally {
            clearTimeout(timer);
          }
        };

        const analysis = await chat(
          'You are an expert web-traffic analyst. Given period metrics for a website, write a concise 2-3 sentence read: what changed in this window, the likely driver, and the single most useful implication. Plain text, no preamble.',
          input, 160,
        );
        if (!analysis) continue;

        // Patterns: peak/dead times and what to do about them, from
        // deterministic aggregates — parsed from 4 labeled lines.
        const patternsRaw = await chat(
          "You are an expert web-traffic analyst. Given aggregated timeline metrics for a website, respond with exactly 4 lines, each starting with its label: 'Peaks:', 'Quiet:', 'Opportunity:', 'Watch:'. Peaks = when traffic concentrates and why it matters. Quiet = dead times and what they imply. Opportunity = the single most actionable opening in these numbers. Watch = the metric or pattern most worth monitoring. One or two plain, concrete sentences per line, grounded in the numbers given. No preamble, no extra lines.",
          buildPatternInput(data), 320,
        );
        const patterns = parsePatterns(patternsRaw);

        await db.insert(schema.timelineAnalyses)
          .values({ projectId: p.id, rangeKey, analysis, patterns })
          .onConflictDoUpdate({
            target: [schema.timelineAnalyses.projectId, schema.timelineAnalyses.rangeKey],
            set: { analysis, patterns, builtAt: new Date() },
          });
        refreshed++;
      } catch (e) {
        console.warn('[timeline] analysis failed', p.id, rangeKey, e instanceof Error ? e.message : e);
      }
    }
  }
  return refreshed;
}

