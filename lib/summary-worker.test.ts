import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { drainSummaryQueue, resetStuckProcessing } from './summary-worker';

const dbReady = await isDbAvailable();
beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  process.env.SUMMARIZER_URL = 'http://summarizer.test:8080';
  process.env.SUMMARIZER_MODEL_LABEL = 'test-model';
});
afterEach(() => { delete process.env.SUMMARIZER_URL; });

async function seedPending(intent = 0) {
  const { project } = await createOrgWithProject();
  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id, anonId: `a${intent}`, startedAt: new Date(), endedAt: new Date(), eventCount: 1,
  }).returning();
  const [row] = await db.insert(schema.sessionSummaries).values({
    sessionId: s.id, digest: { steps: [], insights: [], stats: {} }, digestVersion: 1,
    narrative: '0:00 Landed on /home', insights: [], status: 'pending',
  }).returning();
  return row;
}

const okResponse = () => new Response(JSON.stringify({
  choices: [{ message: { content: 'Visitor browsed pricing and left.' } }],
}), { status: 200 });

describe.skipIf(!dbReady)('drainSummaryQueue', () => {
  it('claims a pending row, calls the summarizer, stores intentText', async () => {
    const row = await seedPending();
    const fetchFn = vi.fn(async () => okResponse());
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch)).toBe(1);
    const [after] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.id, row.id));
    expect(after.status).toBe('done');
    expect(after.intentText).toBe('Visitor browsed pricing and left.');
    expect(after.model).toBe('test-model');
    const url = (fetchFn.mock.calls[0] as unknown[])[0];
    expect(String(url)).toBe('http://summarizer.test:8080/v1/chat/completions');
  });

  it('retries with backoff, fails permanently after 3 attempts', async () => {
    const row = await seedPending();
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    await drainSummaryQueue(fetchFn as unknown as typeof fetch);
    let [after] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.id, row.id));
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.nextRetryAt).not.toBeNull();
    // Force retries due now and exhaust them.
    for (let i = 0; i < 2; i++) {
      await db.update(schema.sessionSummaries).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(schema.sessionSummaries.id, row.id));
      await drainSummaryQueue(fetchFn as unknown as typeof fetch);
    }
    [after] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.id, row.id));
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(3);
  });

  it('is a no-op without SUMMARIZER_URL', async () => {
    delete process.env.SUMMARIZER_URL;
    await seedPending();
    const fetchFn = vi.fn();
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch)).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not touch rows whose nextRetryAt is in the future', async () => {
    const row = await seedPending();
    await db.update(schema.sessionSummaries).set({ attempts: 1, nextRetryAt: new Date(Date.now() + 60_000) }).where(eq(schema.sessionSummaries.id, row.id));
    const fetchFn = vi.fn(async () => okResponse());
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch)).toBe(0);
  });
});

// A digest with steps + an insight so pickFrameMoments yields moments, and
// a session with a real (gzipped) blob so the frame path engages.
const T0 = 1_700_000_000_000;
const VISUAL_DIGEST = {
  steps: [
    { t: T0, kind: 'nav', url: 'https://x.test/' },
    { t: T0 + 60_000, kind: 'click', label: 'Go', tag: 'button' },
  ],
  insights: [{ kind: 'dead_click', at: T0 + 10_000 }],
  stats: { durationMs: 60_000, activeMs: 60_000, pages: [], clickCount: 1, inputFieldCount: 0 },
};

async function seedVisualPending() {
  const { gzipSync } = await import('node:zlib');
  const { project } = await createOrgWithProject();
  const blob = gzipSync(Buffer.from(JSON.stringify({ type: 4, timestamp: T0, data: { href: 'https://x.test/' } }) + '\n'));
  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id, anonId: 'vis', startedAt: new Date(T0), endedAt: new Date(), eventCount: 1, blobBytes: blob.length, blobData: blob,
  }).returning();
  const [row] = await db.insert(schema.sessionSummaries).values({
    sessionId: s.id, digest: VISUAL_DIGEST, digestVersion: 1,
    narrative: '0:00 Landed on /', insights: VISUAL_DIGEST.insights, status: 'pending',
  }).returning();
  return row;
}

describe.skipIf(!dbReady)('drainSummaryQueue visual analysis', () => {
  it('attaches rendered frames as image_url parts when visualEnabled', async () => {
    await seedVisualPending();
    const fakeRenderer = vi.fn(async () => ['FAKEB64A', 'FAKEB64B']);
    const fetchFn = vi.fn(async () => okResponse());
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch, fakeRenderer)).toBe(1);
    expect(fakeRenderer).toHaveBeenCalledWith(expect.any(String), [10_000, 60_000]);
    const body = JSON.parse(String(((fetchFn.mock.calls[0] as unknown[])[1] as { body: string }).body));
    const parts = body.messages[1].content;
    expect(parts.filter((p: { type: string }) => p.type === 'image_url')).toHaveLength(2);
    expect(parts[1].image_url.url).toBe('data:image/jpeg;base64,FAKEB64A');
  });

  it('sends text-only when visualEnabled is off', async () => {
    const { updateAppSettings } = await import('./app-settings');
    await seedVisualPending();
    const [org] = await db.select().from(schema.organizations).limit(1);
    await updateAppSettings(org.id, { visualEnabled: false });
    const fakeRenderer = vi.fn(async () => ['FAKEB64A']);
    const fetchFn = vi.fn(async () => okResponse());
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch, fakeRenderer)).toBe(1);
    expect(fakeRenderer).not.toHaveBeenCalled();
    const body = JSON.parse(String(((fetchFn.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(body.messages[1].content).toHaveLength(1);
  });

  it('is a no-op when intentEnabled is off', async () => {
    const { updateAppSettings } = await import('./app-settings');
    await seedVisualPending();
    const [org] = await db.select().from(schema.organizations).limit(1);
    await updateAppSettings(org.id, { intentEnabled: false });
    const fetchFn = vi.fn();
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch)).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to text-only when the frame renderer throws', async () => {
    await seedVisualPending();
    const fakeRenderer = vi.fn(async () => { throw new Error('chromium unavailable'); });
    const fetchFn = vi.fn(async () => okResponse());
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch, fakeRenderer)).toBe(1);
    const body = JSON.parse(String(((fetchFn.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(body.messages[1].content).toHaveLength(1);
  });
});

describe.skipIf(!dbReady)('drainSummaryQueue ordering', () => {
  it('drains newest rows first so fresh sessions beat the backfill', async () => {
    const { project } = await createOrgWithProject();
    const mkRow = async (anon: string, createdAt: Date, marker: string) => {
      const [s] = await db.insert(schema.sessions).values({
        projectId: project.id, anonId: anon, startedAt: new Date(), endedAt: new Date(), eventCount: 1,
      }).returning();
      await db.insert(schema.sessionSummaries).values({
        sessionId: s.id, digest: { marker }, digestVersion: 1, narrative: '', insights: [], status: 'pending', createdAt,
      });
    };
    await mkRow('old', new Date(Date.now() - 60_000), 'OLD_ROW');
    await mkRow('new', new Date(), 'NEW_ROW');
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(init?.body ?? '');
      return okResponse();
    });
    expect(await drainSummaryQueue(fetchFn as unknown as typeof fetch)).toBe(2);
    expect(bodies[0]).toContain('NEW_ROW');
    expect(bodies[1]).toContain('OLD_ROW');
  });
});

describe.skipIf(!dbReady)('resetStuckProcessing', () => {
  it('returns >10-min-old processing rows to pending', async () => {
    const row = await seedPending();
    await db.update(schema.sessionSummaries).set({ status: 'processing', updatedAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(schema.sessionSummaries.id, row.id));
    await resetStuckProcessing();
    const [after] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.id, row.id));
    expect(after.status).toBe('pending');
  });
});
