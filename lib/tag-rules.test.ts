import { describe, expect, it, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  matchesUrlContains,
  matchesSessionCount,
  matchesBrowserIs,
  matchesCountryIs,
  matchesDeviceIs,
  matchesReferrerContains,
  matchesSourceIs,
  matchesDurationGte,
  matchingUrlContainsRules,
  matchingCreationRules,
  matchingDurationRules,
  tagSession,
  applyRuleToExistingSessions,
  type TagRule,
} from './tag-rules';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

describe('matchesUrlContains', () => {
  it('matches case-insensitively anywhere in the URL', () => {
    expect(matchesUrlContains('register', 'https://example.com/en/register')).toBe(true);
    expect(matchesUrlContains('REGISTER', 'https://example.com/register/success')).toBe(true);
  });

  it('does not match unrelated URLs', () => {
    expect(matchesUrlContains('register', 'https://example.com/login')).toBe(false);
  });
});

describe('matchesSessionCount', () => {
  it('matches when the session number meets the threshold', () => {
    expect(matchesSessionCount('2', 2)).toBe(true);
    expect(matchesSessionCount('2', 3)).toBe(true);
  });

  it('does not match below the threshold', () => {
    expect(matchesSessionCount('2', 1)).toBe(false);
  });

  it('treats a non-numeric value as never matching', () => {
    expect(matchesSessionCount('not-a-number', 5)).toBe(false);
  });
});

describe('single-fact matchers', () => {
  it('matchesBrowserIs is case-insensitive and requires a value', () => {
    expect(matchesBrowserIs('Chrome', 'chrome')).toBe(true);
    expect(matchesBrowserIs('Chrome', 'Safari')).toBe(false);
    expect(matchesBrowserIs('Chrome', null)).toBe(false);
  });

  it('matchesCountryIs is case-insensitive', () => {
    expect(matchesCountryIs('us', 'US')).toBe(true);
    expect(matchesCountryIs('US', 'CA')).toBe(false);
  });

  it('matchesDeviceIs compares device class case-insensitively', () => {
    expect(matchesDeviceIs('mobile', 'mobile')).toBe(true);
    expect(matchesDeviceIs('Mobile', 'mobile')).toBe(true);
    expect(matchesDeviceIs('desktop', 'mobile')).toBe(false);
  });

  it('matchesReferrerContains is a case-insensitive substring match', () => {
    expect(matchesReferrerContains('linkedin', 'https://www.linkedin.com/feed')).toBe(true);
    expect(matchesReferrerContains('linkedin', null)).toBe(false);
  });

  it('matchesSourceIs compares source category case-insensitively', () => {
    expect(matchesSourceIs('ads', 'ads')).toBe(true);
    expect(matchesSourceIs('ads', 'direct')).toBe(false);
  });

  it('matchesDurationGte matches at and above the threshold, never below', () => {
    expect(matchesDurationGte('60', 60)).toBe(true);
    expect(matchesDurationGte('60', 61)).toBe(true);
    expect(matchesDurationGte('60', 59)).toBe(false);
    expect(matchesDurationGte('nope', 100)).toBe(false);
  });
});

describe('matchingCreationRules', () => {
  const rule = (over: Partial<TagRule> = {}): TagRule =>
    ({ id: 'r1', projectId: 'p1', name: 'Chrome users', kind: 'browser_is', value: 'Chrome', color: 'green', enabled: true, ...over });
  const ctx = { browser: 'Chrome', country: 'US', device: 'desktop', referrer: 'https://google.com/search', source: 'search' };

  it('matches enabled single-fact rules against the creation context', () => {
    expect(matchingCreationRules([rule()], ctx).map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores disabled rules and non-creation kinds', () => {
    expect(matchingCreationRules([rule({ enabled: false })], ctx)).toEqual([]);
    expect(matchingCreationRules([rule({ kind: 'url_contains', value: 'x' })], ctx)).toEqual([]);
  });
});

describe('matchingDurationRules', () => {
  const rule = (over: Partial<TagRule> = {}): TagRule =>
    ({ id: 'r1', projectId: 'p1', name: 'Engaged', kind: 'duration_gte', value: '60', color: 'green', enabled: true, ...over });

  it('matches once the duration crosses the threshold', () => {
    expect(matchingDurationRules([rule()], 60).map((r) => r.id)).toEqual(['r1']);
    expect(matchingDurationRules([rule()], 30)).toEqual([]);
  });
});

describe('matchingUrlContainsRules', () => {
  const rule = (over: Partial<TagRule> = {}): TagRule =>
    ({ id: 'r1', projectId: 'p1', name: 'Signed up', kind: 'url_contains', value: 'register', color: 'green', enabled: true, ...over });

  it('matches a rule against the page url', () => {
    const result = matchingUrlContainsRules([rule()], 'https://example.com/register', []);
    expect(result.map((r) => r.id)).toEqual(['r1']);
  });

  it('matches a rule against an event href', () => {
    const result = matchingUrlContainsRules([rule()], null, ['https://example.com/register']);
    expect(result.map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores disabled rules', () => {
    const result = matchingUrlContainsRules([rule({ enabled: false })], 'https://example.com/register', []);
    expect(result).toEqual([]);
  });

  it('ignores session_count_gte rules', () => {
    const result = matchingUrlContainsRules([rule({ kind: 'session_count_gte', value: '2' })], 'https://example.com/register', []);
    expect(result).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(matchingUrlContainsRules([rule()], 'https://example.com/login', [])).toEqual([]);
  });
});

const dbReady = await isDbAvailable();

describe.skipIf(!dbReady)('tagSession / applyRuleToExistingSessions', () => {
  beforeEach(async () => { await resetDb(); });

  function gzBlob(events: unknown[]): Buffer {
    return gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  }

  async function insertSession(projectId: string, anonId: string, startedAt: Date, events: unknown[] = []) {
    const blobData = events.length ? gzBlob(events) : Buffer.alloc(0);
    const [row] = await db.insert(schema.sessions).values({
      projectId, anonId, startedAt,
      blobData, blobBytes: blobData.length,
    }).returning();
    return row;
  }

  it('tagSession is idempotent', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Signed up', kind: 'url_contains', value: 'register' }).returning();
    const s = await insertSession(project.id, 'a1', new Date());
    await tagSession(s.id, [rule.id]);
    await tagSession(s.id, [rule.id]);
    const rows = await db.select().from(schema.sessionTags).where(eq(schema.sessionTags.sessionId, s.id));
    expect(rows.length).toBe(1);
  });

  it('applyRuleToExistingSessions tags matching sessions for session_count_gte, idempotently', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Returning', kind: 'session_count_gte', value: '2' }).returning();
    const s1 = await insertSession(project.id, 'anon-1', new Date(2026, 0, 1));
    const s2 = await insertSession(project.id, 'anon-1', new Date(2026, 0, 2));
    const s3 = await insertSession(project.id, 'anon-1', new Date(2026, 0, 3));
    await insertSession(project.id, 'anon-2', new Date(2026, 0, 1)); // different anon, only 1 session

    const firstRun = await applyRuleToExistingSessions(rule);
    expect(firstRun).toBe(2); // s2 and s3

    const taggedIds = (await db.select({ id: schema.sessionTags.sessionId }).from(schema.sessionTags)).map((r) => r.id).sort();
    expect(taggedIds).toEqual([s2.id, s3.id].sort());
    expect(taggedIds).not.toContain(s1.id);

    const secondRun = await applyRuleToExistingSessions(rule);
    expect(secondRun).toBe(0);
  });

  it('applyRuleToExistingSessions tags matching sessions for url_contains, idempotently', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Signed up', kind: 'url_contains', value: 'register' }).returning();
    const matching = await insertSession(project.id, 'a1', new Date(), [
      { type: 4, timestamp: 1000, data: { href: 'https://example.com/register' } },
    ]);
    const nonMatching = await insertSession(project.id, 'a2', new Date(), [
      { type: 4, timestamp: 1000, data: { href: 'https://example.com/login' } },
    ]);

    const firstRun = await applyRuleToExistingSessions(rule);
    expect(firstRun).toBe(1);

    const taggedIds = (await db.select({ id: schema.sessionTags.sessionId }).from(schema.sessionTags)).map((r) => r.id);
    expect(taggedIds).toEqual([matching.id]);
    expect(taggedIds).not.toContain(nonMatching.id);

    const secondRun = await applyRuleToExistingSessions(rule);
    expect(secondRun).toBe(0);
  });

  it('applyRuleToExistingSessions tags matching sessions for browser_is, idempotently', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Chrome', kind: 'browser_is', value: 'Chrome' }).returning();
    const [chromeSession] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(), browser: 'Chrome',
    }).returning();
    await db.insert(schema.sessions).values({ projectId: project.id, anonId: 'a2', startedAt: new Date(), browser: 'Safari' });

    const firstRun = await applyRuleToExistingSessions(rule);
    expect(firstRun).toBe(1);
    const taggedIds = (await db.select({ id: schema.sessionTags.sessionId }).from(schema.sessionTags)).map((r) => r.id);
    expect(taggedIds).toEqual([chromeSession.id]);

    expect(await applyRuleToExistingSessions(rule)).toBe(0);
  });

  it('applyRuleToExistingSessions tags matching sessions for duration_gte, idempotently', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Engaged', kind: 'duration_gte', value: '60' }).returning();
    const [longSession] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(), durationMs: 90_000,
    }).returning();
    await db.insert(schema.sessions).values({ projectId: project.id, anonId: 'a2', startedAt: new Date(), durationMs: 10_000 });

    const firstRun = await applyRuleToExistingSessions(rule);
    expect(firstRun).toBe(1);
    const taggedIds = (await db.select({ id: schema.sessionTags.sessionId }).from(schema.sessionTags)).map((r) => r.id);
    expect(taggedIds).toEqual([longSession.id]);

    expect(await applyRuleToExistingSessions(rule)).toBe(0);
  });

  it('applyRuleToExistingSessions tags matching sessions for device_is, idempotently', async () => {
    const { project } = await createOrgWithProject();
    const [rule] = await db.insert(schema.tagRules).values({ projectId: project.id, name: 'Mobile', kind: 'device_is', value: 'mobile' }).returning();
    const [mobileSession] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(),
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/21A329',
    }).returning();
    await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a2', startedAt: new Date(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    const firstRun = await applyRuleToExistingSessions(rule);
    expect(firstRun).toBe(1);
    const taggedIds = (await db.select({ id: schema.sessionTags.sessionId }).from(schema.sessionTags)).map((r) => r.id);
    expect(taggedIds).toEqual([mobileSession.id]);

    expect(await applyRuleToExistingSessions(rule)).toBe(0);
  });
});
