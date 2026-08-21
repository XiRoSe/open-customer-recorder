import { describe, it, expect, beforeEach } from 'vitest';
import { buildTimeline, timelineForProject, type TimelineSessionRow } from './timeline';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';

const dbReady = await isDbAvailable();
beforeEach(async () => { if (dbReady) await resetDb(); });

describe.skipIf(!dbReady)('timelineForProject (DB fetch)', () => {
  it('fetches, categorizes, and totals real rows end to end', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(), eventCount: 2, durationMs: 45_000, blobPath: '',
      referrer: 'https://www.google.com/', pageUrl: 'https://x.test/',
    }).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: s.id, digest: {}, digestVersion: 1, narrative: '',
      insights: [{ kind: 'dead_click', at: 1 }], status: 'done',
    });
    const t = await timelineForProject(project.id, '24h');
    expect(t.totals.sessions).toBe(1);
    expect(t.totals.bySource.search).toBe(1);
    expect(t.totals.engaged).toBe(1);
    expect(t.totals.frustrated).toBe(1);
    expect(t.totals.newVisitors).toBe(1);
  });
});

const HOUR = 3600_000;
const END = 1_700_000_000_000;
const WINDOW = 24 * HOUR;

function row(hoursAgo: number, over: Partial<TimelineSessionRow> = {}): TimelineSessionRow {
  const at = new Date(END - hoursAgo * HOUR);
  return {
    startedAt: at, durationMs: 5_000, referrer: null, pageUrl: 'https://x.test/',
    visitorKey: `v-${hoursAgo}-${Math.floor((over.durationMs ?? 0) / 1000)}`, firstSeenAt: at, frustrated: false,
    ...over,
  };
}

describe('buildTimeline', () => {
  it('buckets sessions hourly and categorizes sources', () => {
    const rows = [
      row(1.5, { referrer: 'https://www.google.com/' }),
      row(1.2),
      row(5.5, { referrer: 'https://www.linkedin.com/' }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    expect(t.buckets).toHaveLength(24);
    const b22 = t.buckets[22]; // 1-2 hours ago
    expect(b22.total).toBe(2);
    expect(b22.bySource.search).toBe(1);
    expect(b22.bySource.direct).toBe(1);
    expect(t.buckets[18].bySource.social).toBe(1);
    expect(t.totals.sessions).toBe(3);
  });

  it('computes period-over-period trends', () => {
    const rows = [
      // previous window: 2 sessions; current: 4 → +100%
      row(30), row(40),
      row(2), row(3), row(4, { durationMs: 60_000 }), row(5, { frustrated: true }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    const sessions = t.trends.find((c) => c.label === 'Sessions')!;
    expect(sessions.value).toBe('4 (+100%)');
    expect(sessions.direction).toBe('up');
    expect(t.trends.find((c) => c.label === 'Engaged (30s+)')!.value).toBe('25%');
    expect(t.trends.find((c) => c.label === 'Frustration')!.value).toBe('25%');
  });

  it('flags an emerging source on a big share jump', () => {
    const rows = [
      // previous: all direct
      row(30), row(31), row(32), row(33),
      // current: mostly ads
      row(2, { pageUrl: 'https://x.test/?gclid=1' }), row(3, { pageUrl: 'https://x.test/?gclid=2' }),
      row(4, { pageUrl: 'https://x.test/?gclid=3' }), row(5),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    const emerging = t.trends.find((c) => c.label === 'Emerging source');
    expect(emerging).toBeDefined();
    expect(emerging!.value).toContain('Ads');
  });

  it('marks spike buckets that dwarf the window mean', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row(20 - i * 2 + 0.5)),           // background: 1/bucket
      ...Array.from({ length: 6 }, (_, i) => row(3.5, { visitorKey: `s${i}`, referrer: 'https://www.linkedin.com/' })), // spike
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    const spike = t.buckets.find((b) => b.spike);
    expect(spike).toBeDefined();
    expect(spike!.total).toBe(6);
    expect(spike!.spike!.dominant).toBe('social');
  });

  it('all-time mode: plain totals, no deltas, no emerging source', () => {
    const rows = [
      row(2, { pageUrl: 'https://x.test/?gclid=1' }), row(3, { pageUrl: 'https://x.test/?gclid=2' }),
      row(4, { pageUrl: 'https://x.test/?gclid=3' }), row(5),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR, false);
    expect(t.trends.find((c) => c.label === 'Sessions')!.value).toBe('4');
    expect(t.trends.find((c) => c.label === 'Emerging source')).toBeUndefined();
    expect(t.trends.every((c) => c.direction === 'flat')).toBe(true);
  });

  it('counts new visitors only when their first-ever session is in-window', () => {
    const old = new Date(END - 40 * HOUR);
    const rows = [
      row(2, { visitorKey: 'returning', firstSeenAt: old }),
      row(3, { visitorKey: 'fresh' }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    expect(t.totals.newVisitors).toBe(1);
    expect(t.totals.newSessions).toBe(1);
    expect(t.totals.sessions - t.totals.newSessions).toBe(1);
  });

  it('aggregates avg duration and per-kind friction counts', () => {
    const rows = [
      row(2, { durationMs: 10_000, insightKinds: ['dead_click', 'dead_click'] }),
      row(3, { durationMs: 30_000, insightKinds: ['rage_click'] }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    expect(t.totals.avgDurationMs).toBe(20_000);
    expect(t.totals.insightCounts).toEqual({ dead_click: 2, rage_click: 1 });
  });
});
