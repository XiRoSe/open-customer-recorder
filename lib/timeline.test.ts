import { describe, it, expect, beforeEach } from 'vitest';
import { buildTimeline, buildPatternInput, parsePatterns, deviceOf, timelineForProject, type TimelineSessionRow } from './timeline';
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
      endedAt: new Date(), eventCount: 2, durationMs: 45_000,
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

  it('fetches per-session clicks and tags for the metric stacks', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(), eventCount: 2, durationMs: 45_000, pageUrl: 'https://x.test/',
    }).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: s.id, digestVersion: 1, narrative: '', insights: [], status: 'done',
      // clicks come from stats.clickCount — the steps array is elided
      // to 60 entries and would undercount busy sessions.
      digest: { stats: { clickCount: 2 }, steps: [
        { t: 1, kind: 'click', label: 'Buy', tag: 'button' },
        { t: 2, kind: 'click', label: 'Buy again', tag: 'button' },
        { t: 3, kind: 'nav', to: '/checkout' },
      ] },
    });
    const [rule] = await db.insert(schema.tagRules).values({
      projectId: project.id, name: 'Checkout', kind: 'url_contains', value: 'checkout', color: 'purple',
    }).returning();
    await db.insert(schema.sessionTags).values({ sessionId: s.id, tagRuleId: rule.id });

    const t = await timelineForProject(project.id, '24h');
    const withData = t.buckets.find((b) => b.total > 0)!;
    expect(withData.clicksByDevice.desktop).toBe(2);   // null UA → desktop
    expect(withData.engagedByVisitor.new).toBe(1);      // first-ever session → new
    expect(withData.byTag).toEqual({ Checkout: 1 });
    expect(withData.tagged).toBe(1);
    expect(t.tagMeta).toEqual({ Checkout: { color: 'purple' } });
  });

  it('all-time window ignores sessions with clocks before the project existed', async () => {
    const { project } = await createOrgWithProject();
    await db.insert(schema.sessions).values([
      { projectId: project.id, anonId: 'skewed-clock', startedAt: new Date('1978-08-09T00:00:00Z'),
        endedAt: new Date(), eventCount: 1, durationMs: 1_000, pageUrl: 'https://x.test/' },
      { projectId: project.id, anonId: 'real', startedAt: new Date(Date.now() - 3600_000),
        endedAt: new Date(), eventCount: 1, durationMs: 1_000, pageUrl: 'https://x.test/' },
    ]);
    const t = await timelineForProject(project.id, 'all');
    // A 1978 anchor would mean decades of weekly buckets; the real anchor
    // is the first session recorded after the project existed.
    expect(t.buckets.length).toBeLessThan(100);
    expect(t.totals.sessions).toBe(1);
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
  it('buckets sessions on calendar-aligned hourly boundaries', () => {
    const rows = [
      row(1.5, { referrer: 'https://www.google.com/' }),
      row(1.2),
      row(5.5, { referrer: 'https://www.linkedin.com/' }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    // END sits 13m20s past the hour, so aligning the start down to a
    // real hour boundary yields a 25th (partial) bucket.
    expect(t.buckets).toHaveLength(25);
    expect(t.windowStart % HOUR).toBe(0);
    expect(t.buckets[22].bySource.search).toBe(1);  // 1.5h ago → hour :43
    expect(t.buckets[23].bySource.direct).toBe(1);  // 1.2h ago → next hour :01
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

  it('new-visitor chip reflects share of sessions, matching the split bar', () => {
    const old = new Date(END - 40 * HOUR);
    const rows = [
      row(2, { visitorKey: 'returning', firstSeenAt: old }),
      row(3, { visitorKey: 'fresh-a' }),
      row(4, { visitorKey: 'fresh-b' }),
      row(5, { visitorKey: 'fresh-b' }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    // 3 of 4 sessions are from first-time visitors → 75%, even though
    // only 2 distinct new visitors exist.
    expect(t.trends.find((c) => c.label === 'New visitors')!.value).toBe('75%');
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

describe('deviceOf', () => {
  it('classifies user agents into coarse device classes', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X910) Safari')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126')).toBe('desktop');
    expect(deviceOf(null)).toBe('desktop');
  });
});

describe('origin & device breakdowns', () => {
  it('totals devices, browsers, countries, referrer hosts, and entry paths', () => {
    const rows = [
      row(2, { referrer: 'https://www.producthunt.com/posts/x', pageUrl: 'https://x.test/pricing',
               browser: 'Chrome', country: 'US', userAgent: 'Mozilla/5.0 (iPhone) Mobile' }),
      row(3, { pageUrl: 'https://x.test/pricing', browser: 'Firefox', country: 'IL',
               userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }),
      row(4, { pageUrl: 'https://x.test/', browser: 'Chrome' }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    expect(t.totals.byDevice).toEqual({ mobile: 1, desktop: 2 });
    expect(t.totals.byBrowser).toEqual({ Chrome: 2, Firefox: 1 });
    expect(t.totals.byCountry).toEqual({ US: 1, IL: 1 });
    expect(t.totals.byReferrerHost).toEqual({ 'producthunt.com': 1 });
    expect(t.totals.byEntryPath).toEqual({ '/pricing': 2, '/': 1 });
  });
});

describe('metric stacks', () => {
  it('stacks each measure by its own lens: device, visitor type, signal kind, tag', () => {
    const old = new Date(END - 40 * HOUR);
    const rows = [
      row(2, { clicks: 5, durationMs: 60_000, userAgent: 'Mozilla/5.0 (iPhone) Mobile',
               tags: [{ name: 'Checkout', color: 'purple' }] }),
      row(3, { clicks: 2, durationMs: 45_000, visitorKey: 'ret', firstSeenAt: old,
               frustrated: true, insightKinds: ['dead_click', 'dead_click', 'rage_click'],
               tags: [{ name: 'Checkout', color: 'purple' }, { name: 'Pricing', color: 'blue' }] }),
      row(4, { clicks: 0 }),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    const sum = (pick: (b: (typeof t.buckets)[number]) => Record<string, number>) =>
      t.buckets.reduce((acc, b) => { for (const [k, v] of Object.entries(pick(b))) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>);
    expect(sum((b) => b.clicksByDevice)).toEqual({ mobile: 5, desktop: 2 });
    expect(sum((b) => b.engagedByVisitor)).toEqual({ new: 1, returning: 1 });
    expect(sum((b) => b.frictionByKind)).toEqual({ dead_click: 2, rage_click: 1 });
    expect(t.buckets.reduce((a, b) => a + b.frustrated, 0)).toBe(1);
    expect(sum((b) => b.byTag)).toEqual({ Checkout: 2, Pricing: 1 });
    expect(t.buckets.reduce((a, b) => a + b.tagged, 0)).toBe(2);
    expect(t.tagMeta).toEqual({ Checkout: { color: 'purple' }, Pricing: { color: 'blue' } });
  });
});

describe('buildPatternInput', () => {
  it('surfaces busiest buckets, quiet stretches, and totals', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(3.5, { visitorKey: `p${i}` })),
      row(20.5), row(21.5),
    ];
    const t = buildTimeline(rows, END, WINDOW, HOUR);
    const input = buildPatternInput(t);
    expect(input).toContain('Busiest hours:');
    expect(input).toContain('(6 sessions)');
    expect(input).toContain('Quietest stretch:');
    expect(input).toContain('Totals: 8 sessions');
    expect(input).toContain('Sources: Direct 100%');
  });
});

describe('parsePatterns', () => {
  it('parses the 4 labeled lines', () => {
    const p = parsePatterns('Peaks: Mornings dominate.\nQuiet: Nights are dead.\nOpportunity: Schedule launches at 09:00.\nWatch: Frustration rate.');
    expect(p).toEqual({
      peaks: 'Mornings dominate.', quiet: 'Nights are dead.',
      opportunity: 'Schedule launches at 09:00.', watch: 'Frustration rate.',
    });
  });

  it('tolerates markdown bullets and bold labels, and a missing line', () => {
    const p = parsePatterns('- **Peaks**: Mid-week.\n* Quiet: Weekends.\n**Opportunity:** Push ads Tuesday.');
    expect(p).toEqual({ peaks: 'Mid-week.', quiet: 'Weekends.', opportunity: 'Push ads Tuesday.', watch: '' });
  });

  it('rejects output with fewer than 3 recognizable lines', () => {
    expect(parsePatterns('Traffic looks fine overall, nothing to note.')).toBeNull();
  });
});
