import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { signSessionJwt } from '@/lib/auth';

// Next 16's cookies() throws outside a real request scope, so route
// handlers can't be invoked directly in vitest with a cookie header.
// Back it with a test-controlled store instead.
let cookieStore: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore[name] !== undefined ? { name, value: cookieStore[name] } : undefined),
  }),
}));

const dbReady = await isDbAvailable();
beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  cookieStore = {};
  process.env.JWT_SECRET = 'jwt-secret-must-be-at-least-32-bytes-aaaa';
});

async function seed() {
  const { org, project } = await createOrgWithProject();
  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id, anonId: 'a1', startedAt: new Date(), endedAt: new Date(), eventCount: 1,
  }).returning();
  await db.insert(schema.sessionSummaries).values({
    sessionId: s.id, digest: {}, digestVersion: 1, narrative: '0:00 Landed on /', insights: [],
    intentText: 'Browsed.', status: 'done', attempts: 3,
  });
  const token = await signSessionJwt({ orgId: org.id, email: 'admin@example.com', userId: 'u-1', name: 'Admin', userRole: 'owner' });
  return { s, token };
}

describe.skipIf(!dbReady)('GET/POST /api/admin/sessions/:id/summary', () => {
  it('GET returns the summary row, org-scoped', async () => {
    const { s, token } = await seed();
    cookieStore.mega_session = token;
    const res = await GET(
      new Request(`http://localhost/api/admin/sessions/${s.id}/summary`),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.summary.intentText).toBe('Browsed.');
    expect(json.summary.status).toBe('done');
  });

  it('GET returns null summary when no row exists yet', async () => {
    const { s, token } = await seed();
    cookieStore.mega_session = token;
    await db.delete(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, s.id));
    const res = await GET(
      new Request(`http://localhost/api/admin/sessions/${s.id}/summary`),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect((await res.json()).summary).toBeNull();
  });

  it('POST resets the row to pending with attempts 0', async () => {
    const { s, token } = await seed();
    cookieStore.mega_session = token;
    const res = await POST(
      new Request(`http://localhost/api/admin/sessions/${s.id}/summary`, { method: 'POST' }),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, s.id));
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  it('rejects unauthenticated', async () => {
    const { s } = await seed();
    const res = await GET(new Request(`http://localhost/api/admin/sessions/${s.id}/summary`), { params: Promise.resolve({ id: s.id }) });
    expect(res.status).toBe(401);
  });
});
