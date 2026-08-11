import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { makeUrlChangeEvent } from '@/lib/url-timeline';

const dbReady = await isDbAvailable();

beforeEach(async () => { if (dbReady) await resetDb(); });

function ndjson(events: unknown[]): Buffer {
  return gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
}

async function post(projectKey: string, sid: string, opts: { u?: string; events?: unknown[]; anonId?: string }) {
  const url = new URL(`http://localhost/api/ingest/v2/events`);
  url.searchParams.set('k', projectKey);
  url.searchParams.set('sid', sid);
  url.searchParams.set('a', opts.anonId ?? 'anon-1');
  if (opts.u) url.searchParams.set('u', opts.u);
  const body = opts.events ? ndjson(opts.events) : Buffer.alloc(0);
  return POST(new Request(url.toString(), {
    method: 'POST',
    headers: opts.events ? { 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson' } : {},
    body: opts.events ? new Uint8Array(body) : undefined,
  }));
}

async function tagNames(sid: string): Promise<string[]> {
  const rows = await db.select({ name: schema.tagRules.name })
    .from(schema.sessionTags)
    .innerJoin(schema.tagRules, eq(schema.tagRules.id, schema.sessionTags.tagRuleId))
    .where(eq(schema.sessionTags.sessionId, sid));
  return rows.map((r) => r.name).sort();
}

async function addRule(projectId: string, name: string, kind: string, value: string, enabled = true) {
  const [rule] = await db.insert(schema.tagRules).values({ projectId, name, kind, value, enabled }).returning();
  return rule;
}

describe.skipIf(!dbReady)('POST /api/ingest/v2/events — tag rules', () => {
  it('tags via url_contains on a Meta event href', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Signed up', 'url_contains', 'register');
    const sid = randomUUID();
    const res = await post(project.projectKey, sid, {
      u: 'https://example.com/en/register',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/en/register' } }],
    });
    expect(res.status).toBe(204);
    expect(await tagNames(sid)).toEqual(['Signed up']);
  });

  it('tags via url_contains on a mega-url-change event href', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Signed up', 'url_contains', 'register');
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
    });
    await post(project.projectKey, sid, {
      u: 'https://example.com/register',
      events: [makeUrlChangeEvent('https://example.com/register', Date.now())],
    });
    expect(await tagNames(sid)).toEqual(['Signed up']);
  });

  it('does not tag when no URL matches', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Signed up', 'url_contains', 'register');
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/en',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/en' } }],
    });
    expect(await tagNames(sid)).toEqual([]);
  });

  it('ignores a disabled rule', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Signed up', 'url_contains', 'register', false);
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/register',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/register' } }],
    });
    expect(await tagNames(sid)).toEqual([]);
  });

  it('is sticky — a later batch with no match does not un-tag', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Signed up', 'url_contains', 'register');
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/register',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/register' } }],
    });
    expect(await tagNames(sid)).toEqual(['Signed up']);
    await post(project.projectKey, sid, {
      u: 'https://example.com/dashboard',
      events: [makeUrlChangeEvent('https://example.com/dashboard', Date.now())],
    });
    expect(await tagNames(sid)).toEqual(['Signed up']);
  });

  it('does not tag session_count_gte:2 on the first session for an anon_id', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Returning', 'session_count_gte', '2');
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'anon-returning',
    });
    expect(await tagNames(sid)).toEqual([]);
  });

  it('tags session_count_gte:2 on the second session for the same anon_id', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Returning', 'session_count_gte', '2');
    const first = randomUUID();
    await post(project.projectKey, first, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'anon-returning',
    });
    const second = randomUUID();
    await post(project.projectKey, second, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'anon-returning',
    });
    expect(await tagNames(second)).toEqual(['Returning']);
    // The first session isn't retroactively tagged — session_count_gte is
    // evaluated once, at creation time, before the second session existed.
    expect(await tagNames(first)).toEqual([]);
  });

  it('does not re-evaluate session_count_gte on later batches of the same session', async () => {
    const { project } = await createOrgWithProject();
    await addRule(project.id, 'Returning', 'session_count_gte', '2');
    const first = randomUUID();
    await post(project.projectKey, first, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'anon-x',
    });
    const second = randomUUID();
    await post(project.projectKey, second, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'anon-x',
    });
    // A later batch on the FIRST session (now the anon_id's count is 2)
    // must not retroactively tag it — count is only checked at creation.
    await post(project.projectKey, first, {
      u: 'https://example.com/next',
      events: [makeUrlChangeEvent('https://example.com/next', Date.now())],
      anonId: 'anon-x',
    });
    expect(await tagNames(first)).toEqual([]);
  });
});

describe.skipIf(!dbReady)('POST /api/ingest/v2/events — excluded anon_ids', () => {
  it('does not create a session row for an excluded anon_id', async () => {
    const { project } = await createOrgWithProject();
    await db.insert(schema.excludedAnonIds).values({ projectId: project.id, anonId: 'admin-anon' });
    const sid = randomUUID();
    const res = await post(project.projectKey, sid, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'admin-anon',
    });
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sid));
    expect(rows.length).toBe(0);
  });

  it('still records a non-excluded anon_id in the same project', async () => {
    const { project } = await createOrgWithProject();
    await db.insert(schema.excludedAnonIds).values({ projectId: project.id, anonId: 'admin-anon' });
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'someone-else',
    });
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sid));
    expect(rows.length).toBe(1);
  });

  it('stops recording an already-active session once its anon_id is excluded', async () => {
    const { project } = await createOrgWithProject();
    const sid = randomUUID();
    await post(project.projectKey, sid, {
      u: 'https://example.com/',
      events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      anonId: 'admin-anon',
    });
    const [before] = await db.select({ eventCount: schema.sessions.eventCount }).from(schema.sessions).where(eq(schema.sessions.id, sid));
    expect(before.eventCount).toBe(1);

    await db.insert(schema.excludedAnonIds).values({ projectId: project.id, anonId: 'admin-anon' });
    await post(project.projectKey, sid, {
      u: 'https://example.com/next',
      events: [makeUrlChangeEvent('https://example.com/next', Date.now())],
      anonId: 'admin-anon',
    });
    const [after] = await db.select({ eventCount: schema.sessions.eventCount }).from(schema.sessions).where(eq(schema.sessions.id, sid));
    expect(after.eventCount).toBe(1); // unchanged — the second batch was dropped
  });
});
