import { describe, expect, it, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  matchesUrlContains,
  matchesSessionCount,
  matchingUrlContainsRules,
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

describe('matchingUrlContainsRules', () => {
  const rule = (over: Partial<TagRule> = {}): TagRule =>
    ({ id: 'r1', projectId: 'p1', name: 'Signed up', kind: 'url_contains', value: 'register', enabled: true, ...over });

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
      projectId, anonId, startedAt, blobPath: 'x',
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
});
