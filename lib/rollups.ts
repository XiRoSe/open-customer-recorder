// Hourly pre-aggregation for the timeline. Jobs recompute a whole hour
// from raw sessions (idempotent upsert), so re-running is always safe;
// zero-session hours get an explicit row so the reader can PROVE
// coverage before trusting rollups over raw rows.
import { sql, and, eq, gte, lt, asc } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import {
  timelineRowsForProject, deviceOf,
  type TimelineData, type TimelineBucket, type TimelineTotals, type TrendChip,
} from './timeline';
import { categorizeSource, SOURCE_CATEGORIES, type SourceCategory } from './traffic-source';

const HOUR_MS = 3600_000;
const SPIKE_Z = 2;

type NumMap = Record<string, number>;

const bump = (rec: NumMap, key: string | null | undefined, by = 1) => {
  if (key) rec[key] = (rec[key] ?? 0) + by;
};
const addInto = (into: NumMap, from: unknown) => {
  for (const [k, v] of Object.entries((from ?? {}) as NumMap)) into[k] = (into[k] ?? 0) + Number(v);
};

const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
};
const pathOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const p = new URL(url).pathname || '/';
    return p.length > 48 ? `${p.slice(0, 47)}…` : p;
  } catch { return null; }
};

/** Recompute one project-hour from raw rows and upsert its rollup. */
export async function buildHourRollup(projectId: string, hourStartMs: number): Promise<void> {
  const hourStart = Math.floor(hourStartMs / HOUR_MS) * HOUR_MS;
  const hourEnd = hourStart + HOUR_MS;
  const rows = (await timelineRowsForProject(projectId, hourEnd, HOUR_MS))
    .filter((r) => r.startedAt.getTime() >= hourStart && r.startedAt.getTime() < hourEnd);

  const agg = {
    sessions: 0, engaged: 0, engagedNew: 0, frustrated: 0,
    newVisitorSessions: 0, durationSumMs: 0, clicks: 0, tagged: 0,
    bySource: {} as NumMap, clicksByDevice: {} as NumMap, frictionByKind: {} as NumMap,
    byTag: {} as NumMap, byDevice: {} as NumMap, byBrowser: {} as NumMap,
    byCountry: {} as NumMap, byReferrerHost: {} as NumMap, byEntryPath: {} as NumMap,
    byEntryFriction: {} as Record<string, { n: number; bad: number }>,
  };
  for (const r of rows) {
    agg.sessions++;
    const engaged = (r.durationMs ?? 0) >= 30_000;
    // First-ever session of this visitor. Over a window that starts at
    // the project's first session, summing these equals both the new-
    // session count and the distinct new-visitor count.
    const isNew = r.firstSeenAt.getTime() === r.startedAt.getTime();
    if (engaged) { agg.engaged++; if (isNew) agg.engagedNew++; }
    if (r.frustrated) agg.frustrated++;
    if (isNew) agg.newVisitorSessions++;
    agg.durationSumMs += r.durationMs ?? 0;
    agg.clicks += r.clicks ?? 0;
    if ((r.tags ?? []).length > 0) agg.tagged++;
    bump(agg.bySource, categorizeSource(r.referrer, r.pageUrl));
    bump(agg.clicksByDevice, deviceOf(r.userAgent), r.clicks ?? 0);
    for (const k of r.insightKinds ?? []) bump(agg.frictionByKind, k);
    for (const tag of r.tags ?? []) bump(agg.byTag, tag.name);
    bump(agg.byDevice, deviceOf(r.userAgent));
    bump(agg.byBrowser, r.browser);
    bump(agg.byCountry, r.country);
    bump(agg.byReferrerHost, hostOf(r.referrer));
    const p = pathOf(r.pageUrl);
    if (p) {
      bump(agg.byEntryPath, p);
      const e = agg.byEntryFriction[p] ?? { n: 0, bad: 0 };
      e.n++;
      if (r.frustrated) e.bad++;
      agg.byEntryFriction[p] = e;
    }
  }

  await db.insert(schema.timelineRollups)
    .values({ projectId, hourStart: new Date(hourStart), ...agg })
    .onConflictDoUpdate({
      target: [schema.timelineRollups.projectId, schema.timelineRollups.hourStart],
      set: { ...agg, builtAt: new Date() },
    });
}

/** Hours (since the project's first plausible session) that have no
 * rollup yet, plus the last two hours for live refresh. Bounded and
 * cheap: one group-by over the index. */
export async function hoursNeedingRollup(projectId: string, limit = 200): Promise<number[]> {
  interface Row extends Record<string, unknown> { h: string }
  const res = await db.execute<Row>(sql`
    WITH bounds AS (
      SELECT date_trunc('hour', min(s.started_at)) AS first_hour
      FROM ${schema.sessions} s
      WHERE s.project_id = ${projectId} AND s.event_count > 0
        AND s.started_at >= (SELECT p.created_at FROM ${schema.projects} p WHERE p.id = ${projectId})
    ),
    hours AS (
      SELECT generate_series(first_hour, date_trunc('hour', now()), interval '1 hour') AS h
      FROM bounds WHERE first_hour IS NOT NULL
    )
    SELECT hours.h FROM hours
    LEFT JOIN ${schema.timelineRollups} r
      ON r.project_id = ${projectId} AND r.hour_start = hours.h
    WHERE r.id IS NULL OR hours.h >= date_trunc('hour', now()) - interval '1 hour'
    ORDER BY hours.h DESC
    LIMIT ${limit}
  `);
  const rows: Row[] = Array.isArray(res) ? res : (res as unknown as { rows: Row[] }).rows ?? [];
  return rows.map((r) => new Date(r.h).getTime());
}

interface RollupRow {
  hourStart: Date;
  sessions: number; engaged: number; engagedNew: number; frustrated: number;
  newVisitorSessions: number; durationSumMs: number; clicks: number; tagged: number;
  bySource: unknown; clicksByDevice: unknown; frictionByKind: unknown; byTag: unknown;
  byDevice: unknown; byBrowser: unknown; byCountry: unknown; byReferrerHost: unknown;
  byEntryPath: unknown; byEntryFriction: unknown;
}

/** Assemble TimelineData for a window entirely from rollups. Returns
 * null unless EVERY hour in [windowStart, lastFullHour) has a row —
 * partial coverage falls back to raw so numbers are never silently low.
 * The current partial hour is fetched raw and merged in. */
export async function timelineFromRollups(
  projectId: string, windowStart: number, windowEnd: number, bucketMs: number,
): Promise<TimelineData | null> {
  const alignedStart = Math.floor(windowStart / bucketMs) * bucketMs;
  const currentHour = Math.floor(windowEnd / HOUR_MS) * HOUR_MS;
  // Coverage is measured from the window's first real hour — bucket
  // alignment (weekly especially) can reach back before any session
  // existed, and those hours legitimately have no rollup rows.
  const coverageStart = Math.floor(windowStart / HOUR_MS) * HOUR_MS;
  const expectedHours = Math.max(0, Math.ceil((currentHour - coverageStart) / HOUR_MS));

  const rollups = (await db.select().from(schema.timelineRollups)
    .where(and(
      eq(schema.timelineRollups.projectId, projectId),
      gte(schema.timelineRollups.hourStart, new Date(coverageStart)),
      lt(schema.timelineRollups.hourStart, new Date(currentHour)),
    ))
    .orderBy(asc(schema.timelineRollups.hourStart))) as RollupRow[];
  if (expectedHours === 0 || rollups.length < expectedHours) return null; // coverage gap → raw

  // Live tail: the current partial hour, raw.
  const tailRows = (await timelineRowsForProject(projectId, windowEnd, windowEnd - currentHour || 1))
    .filter((r) => r.startedAt.getTime() >= currentHour && r.startedAt.getTime() < windowEnd);
  const tail = { sessions: 0, engaged: 0, engagedNew: 0, frustrated: 0, newVisitorSessions: 0, durationSumMs: 0, clicks: 0, tagged: 0, bySource: {} as NumMap, clicksByDevice: {} as NumMap, frictionByKind: {} as NumMap, byTag: {} as NumMap, byDevice: {} as NumMap, byBrowser: {} as NumMap, byCountry: {} as NumMap, byReferrerHost: {} as NumMap, byEntryPath: {} as NumMap, hourStart: new Date(currentHour), byEntryFriction: {} };
  for (const r of tailRows) {
    tail.sessions++;
    const isNew = r.firstSeenAt.getTime() === r.startedAt.getTime();
    if ((r.durationMs ?? 0) >= 30_000) { tail.engaged++; if (isNew) tail.engagedNew++; }
    if (r.frustrated) tail.frustrated++;
    if (isNew) tail.newVisitorSessions++;
    tail.durationSumMs += r.durationMs ?? 0;
    tail.clicks += r.clicks ?? 0;
    if ((r.tags ?? []).length > 0) tail.tagged++;
    bump(tail.bySource, categorizeSource(r.referrer, r.pageUrl));
    bump(tail.clicksByDevice, deviceOf(r.userAgent), r.clicks ?? 0);
    for (const k of r.insightKinds ?? []) bump(tail.frictionByKind, k);
    for (const tag of r.tags ?? []) bump(tail.byTag, tag.name);
    bump(tail.byDevice, deviceOf(r.userAgent));
    bump(tail.byBrowser, r.browser);
    bump(tail.byCountry, r.country);
    bump(tail.byReferrerHost, hostOf(r.referrer));
    bump(tail.byEntryPath, pathOf(r.pageUrl));
  }
  const hours: RollupRow[] = [...rollups, tail as unknown as RollupRow];

  const bucketCount = Math.ceil((windowEnd - alignedStart) / bucketMs);
  const emptySources = () => Object.fromEntries(SOURCE_CATEGORIES.map((s) => [s, 0])) as Record<SourceCategory, number>;
  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: alignedStart + i * bucketMs,
    bySource: emptySources(), total: 0,
    clicksByDevice: {}, engagedByVisitor: { new: 0, returning: 0 },
    frictionByKind: {}, frustrated: 0, byTag: {}, tagged: 0,
  }));

  const totals: TimelineTotals = {
    sessions: 0, engaged: 0, frustrated: 0, newVisitors: 0, newSessions: 0,
    avgDurationMs: 0, insightCounts: {}, bySource: emptySources(),
    byDevice: {}, byBrowser: {}, byCountry: {}, byReferrerHost: {}, byEntryPath: {},
  };
  let durSum = 0;

  for (const h of hours) {
    const t = h.hourStart.getTime();
    const b = buckets[Math.min(bucketCount - 1, Math.max(0, Math.floor((t - alignedStart) / bucketMs)))];
    b.total += h.sessions;
    addInto(b.bySource as NumMap, h.bySource);
    addInto(b.clicksByDevice, h.clicksByDevice);
    b.engagedByVisitor.new += h.engagedNew;
    b.engagedByVisitor.returning += h.engaged - h.engagedNew;
    addInto(b.frictionByKind, h.frictionByKind);
    b.frustrated += h.frustrated;
    addInto(b.byTag, h.byTag);
    b.tagged += h.tagged;

    totals.sessions += h.sessions;
    totals.engaged += h.engaged;
    totals.frustrated += h.frustrated;
    totals.newVisitors += h.newVisitorSessions;
    totals.newSessions += h.newVisitorSessions;
    durSum += h.durationSumMs;
    addInto(totals.insightCounts, h.frictionByKind);
    addInto(totals.bySource as NumMap, h.bySource);
    addInto(totals.byDevice, h.byDevice);
    addInto(totals.byBrowser, h.byBrowser);
    addInto(totals.byCountry, h.byCountry);
    addInto(totals.byReferrerHost, h.byReferrerHost);
    addInto(totals.byEntryPath, h.byEntryPath);
  }
  totals.avgDurationMs = totals.sessions > 0 ? durSum / totals.sessions : 0;

  // Spikes: same z-score rule as the raw path.
  const arr = buckets.map((b) => b.total);
  const mean = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, arr.length));
  for (const b of buckets) {
    if (sd > 0 && b.total >= 3 && (b.total - mean) / sd >= SPIKE_Z) {
      const dominant = SOURCE_CATEGORIES.reduce((best, s) => (b.bySource[s] > b.bySource[best] ? s : best), SOURCE_CATEGORIES[0]);
      b.spike = { factor: Math.round((b.total / Math.max(0.5, mean)) * 10) / 10, dominant };
    }
  }

  // Plain-total chips — rollups only serve the no-comparison 'all' range.
  const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);
  const trends: TrendChip[] = [
    { label: 'Sessions', value: `${totals.sessions}`, direction: 'flat' },
    { label: 'Engaged (30s+)', value: `${pct(totals.engaged, totals.sessions)}%`, direction: 'flat' },
    { label: 'Frustration', value: `${pct(totals.frustrated, totals.sessions)}%`, direction: 'flat' },
    { label: 'New visitors', value: `${pct(totals.newSessions, Math.max(1, totals.sessions))}%`, direction: 'flat' },
  ];

  // Tag colors come from the rules, not the rows.
  const rules = await db.select({ name: schema.tagRules.name, color: schema.tagRules.color })
    .from(schema.tagRules).where(eq(schema.tagRules.projectId, projectId));
  const tagMeta: Record<string, { color: string }> = {};
  for (const r of rules) tagMeta[r.name] ??= { color: r.color };

  return { buckets, totals, trends, windowStart: alignedStart, windowEnd, bucketMs, tagMeta };
}

/** Worst friction entry page from rollups — the Overview's callout when
 * the window was served from rollups instead of raw rows. */
export async function frictionEntryFromRollups(
  projectId: string, windowStart: number, windowEnd: number,
): Promise<{ path: string; rate: number; sessions: number } | null> {
  const rollups = await db.select({ byEntryFriction: schema.timelineRollups.byEntryFriction })
    .from(schema.timelineRollups)
    .where(and(
      eq(schema.timelineRollups.projectId, projectId),
      gte(schema.timelineRollups.hourStart, new Date(windowStart)),
      lt(schema.timelineRollups.hourStart, new Date(windowEnd)),
    ));
  const byPath = new Map<string, { n: number; bad: number }>();
  for (const r of rollups) {
    for (const [path, v] of Object.entries((r.byEntryFriction ?? {}) as Record<string, { n: number; bad: number }>)) {
      const e = byPath.get(path) ?? { n: 0, bad: 0 };
      e.n += v.n; e.bad += v.bad;
      byPath.set(path, e);
    }
  }
  let best: { path: string; rate: number; sessions: number } | null = null;
  for (const [path, { n, bad }] of byPath) {
    if (n < 5) continue;
    const rate = bad / n;
    if (rate >= 0.2 && (!best || rate > best.rate)) best = { path, rate: Math.round(rate * 100), sessions: n };
  }
  return best;
}
