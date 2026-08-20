import { describe, it, expect, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { runSummarySweepOnce, summariesForSessions } from './session-summaries';
import { DIGEST_VERSION } from './session-digest';

const dbReady = await isDbAvailable();
beforeEach(async () => { if (dbReady) await resetDb(); });

const T0 = 1_700_000_000_000;
function makeBlob(): Buffer {
  const events = [
    { type: 4, timestamp: T0, data: { href: 'https://x.test/home' } },
    { type: 2, timestamp: T0, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'button', attributes: {}, childNodes: [{ type: 3, id: 3, textContent: 'Pricing' }] }] } } },
    { type: 3, timestamp: T0 + 1000, data: { source: 2, type: 2, id: 2, x: 1, y: 1 } },
  ];
  return gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
}

describe.skipIf(!dbReady)('runSummarySweepOnce', () => {
  it('digests ended sessions and upserts a pending summary row', async () => {
    const { project } = await createOrgWithProject();
    const blob = makeBlob();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(T0), endedAt: new Date(T0 + 1000),
      eventCount: 3, blobPath: '', blobBytes: blob.length, blobData: blob,
    }).returning();
    const n = await runSummarySweepOnce();
    expect(n).toBe(1);
    const [row] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, s.id));
    expect(row.status).toBe('pending');
    expect(row.digestVersion).toBe(DIGEST_VERSION);
    expect(row.narrative).toContain('Clicked "Pricing"');
  });

  it('skips live sessions (no endedAt, recent activity) and 0-event sessions', async () => {
    const { project } = await createOrgWithProject();
    await db.insert(schema.sessions).values([
      { projectId: project.id, anonId: 'live', startedAt: new Date(), lastActivityAt: new Date(), eventCount: 5, blobPath: '', blobData: makeBlob() },
      { projectId: project.id, anonId: 'empty', startedAt: new Date(), endedAt: new Date(), eventCount: 0, blobPath: '' },
    ]);
    expect(await runSummarySweepOnce()).toBe(0);
  });

  it('sweeps abandoned sessions (no endedAt but idle >10 min)', async () => {
    const { project } = await createOrgWithProject();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'gone', startedAt: old, lastActivityAt: old,
      eventCount: 3, blobPath: '', blobData: makeBlob(),
    });
    expect(await runSummarySweepOnce()).toBe(1);
  });

  it('re-digests rows with a stale digestVersion', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(T0), endedAt: new Date(),
      eventCount: 3, blobPath: '', blobData: makeBlob(),
    }).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: s.id, digest: {}, digestVersion: DIGEST_VERSION - 1, narrative: 'old', insights: [],
    });
    expect(await runSummarySweepOnce()).toBe(1);
    const [row] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, s.id));
    expect(row.digestVersion).toBe(DIGEST_VERSION);
    expect(row.narrative).toContain('Pricing');
  });

  it('writes a failed row instead of throwing on a corrupt blob', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'bad', startedAt: new Date(), endedAt: new Date(),
      eventCount: 3, blobPath: '', blobData: Buffer.from('not gzip at all'),
    }).returning();
    await expect(runSummarySweepOnce()).resolves.toBe(1);
    const [row] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, s.id));
    expect(row.status).toBe('failed');
  });
});

describe.skipIf(!dbReady)('summariesForSessions', () => {
  it('returns intent/narrative/status keyed by session id', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a1', startedAt: new Date(), endedAt: new Date(), eventCount: 1, blobPath: '',
    }).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: s.id, digest: {}, digestVersion: DIGEST_VERSION, narrative: '0:00 Landed on /',
      insights: [], intentText: 'Browsed the pricing page.', status: 'done',
    });
    const m = await summariesForSessions([s.id]);
    expect(m.get(s.id)).toEqual({ intentText: 'Browsed the pricing page.', narrative: '0:00 Landed on /', status: 'done' });
  });
});
