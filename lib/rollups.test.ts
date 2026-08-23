import { describe, it, expect, beforeEach } from 'vitest';
import { buildHourRollup, timelineFromRollups } from './rollups';
import { timelineRowsForProject, buildTimeline } from './timeline';
import { queuesEnabled, redisConnection, getQueue } from './queue';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';

const dbReady = await isDbAvailable();
beforeEach(async () => { if (dbReady) await resetDb(); });

describe('queue guards', () => {
  it('is fully disabled without REDIS_URL', () => {
    expect(process.env.REDIS_URL).toBeUndefined();
    expect(queuesEnabled()).toBe(false);
    expect(redisConnection()).toBeNull();
    expect(getQueue('summaries')).toBeNull();
  });
});

describe.skipIf(!dbReady)('timeline rollups', () => {
  it('rollup-served timeline matches the raw computation', async () => {
    const { project } = await createOrgWithProject();
    const now = Date.now();
    const HOUR = 3600_000;
    const h = (n: number, plus = 0) => new Date(Math.floor(now / HOUR) * HOUR - n * HOUR + plus);

    // Two active hours + friction + tags + a returning visitor.
    const values = [
      { anonId: 'a', startedAt: h(5, 60_000), durationMs: 45_000, referrer: 'https://www.google.com/', pageUrl: 'https://x.test/pricing' },
      { anonId: 'a', startedAt: h(3, 120_000), durationMs: 61_000, pageUrl: 'https://x.test/' },
      { anonId: 'b', startedAt: h(3, 300_000), durationMs: 4_000, pageUrl: 'https://x.test/login',
        browser: 'Chrome', country: 'US', userAgent: 'Mozilla/5.0 (iPhone) Mobile' },
    ].map((v) => ({ projectId: project.id, endedAt: new Date(), eventCount: 2, ...v }));
    const inserted = await db.insert(schema.sessions).values(values).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: inserted[2].id, digestVersion: 1, narrative: '', status: 'done',
      insights: [{ kind: 'dead_click', at: 1 }],
      digest: { steps: [{ t: 1, kind: 'click', label: 'x', tag: 'a' }] },
    });
    const [rule] = await db.insert(schema.tagRules).values({
      projectId: project.id, name: 'Checkout', kind: 'url_contains', value: 'pricing', color: 'green',
    }).returning();
    await db.insert(schema.sessionTags).values({ sessionId: inserted[0].id, tagRuleId: rule.id });

    const windowStart = h(6).getTime();
    const windowEnd = now;
    // Build every hour in the window (including empty ones — coverage).
    for (let t = Math.floor(windowStart / HOUR) * HOUR; t < windowEnd; t += HOUR) {
      await buildHourRollup(project.id, t);
    }

    const rolled = await timelineFromRollups(project.id, windowStart, windowEnd, HOUR);
    expect(rolled).not.toBeNull();
    const raw = buildTimeline(
      await timelineRowsForProject(project.id, windowEnd, windowEnd - windowStart + HOUR),
      windowEnd, windowEnd - windowStart, HOUR, false,
    );

    expect(rolled!.totals.sessions).toBe(raw.totals.sessions);
    expect(rolled!.totals.engaged).toBe(raw.totals.engaged);
    expect(rolled!.totals.frustrated).toBe(raw.totals.frustrated);
    expect(rolled!.totals.bySource).toEqual(raw.totals.bySource);
    expect(rolled!.totals.insightCounts).toEqual(raw.totals.insightCounts);
    expect(rolled!.totals.byDevice).toEqual(raw.totals.byDevice);
    expect(rolled!.totals.byBrowser).toEqual(raw.totals.byBrowser);
    expect(rolled!.totals.byCountry).toEqual(raw.totals.byCountry);
    expect(rolled!.totals.byEntryPath).toEqual(raw.totals.byEntryPath);
    expect(Math.round(rolled!.totals.avgDurationMs)).toBe(Math.round(raw.totals.avgDurationMs));
    // New visitors: first-ever semantics equal window semantics when the
    // window starts at the first session — as the 'all' range does.
    expect(rolled!.totals.newVisitors).toBe(raw.totals.newVisitors);
    expect(rolled!.buckets.map((b) => b.total)).toEqual(raw.buckets.map((b) => b.total));
    const sumTags = (bs: { byTag: Record<string, number> }[]) =>
      bs.reduce((a, b) => a + (b.byTag.Checkout ?? 0), 0);
    expect(sumTags(rolled!.buckets)).toBe(sumTags(raw.buckets));
    expect(rolled!.tagMeta).toEqual({ Checkout: { color: 'green' } });
  });

  it('refuses to serve a window with a coverage gap', async () => {
    const { project } = await createOrgWithProject();
    const HOUR = 3600_000;
    const now = Date.now();
    await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a', startedAt: new Date(now - 5 * HOUR),
      endedAt: new Date(), eventCount: 1, durationMs: 1_000, pageUrl: 'https://x.test/',
    });
    // Only one hour built out of five → must fall back to raw.
    await buildHourRollup(project.id, now - 5 * HOUR);
    const rolled = await timelineFromRollups(project.id, now - 5 * HOUR, now, HOUR);
    expect(rolled).toBeNull();
  });
});
