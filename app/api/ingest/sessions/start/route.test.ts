import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

const dbReady = await isDbAvailable();

function req(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/ingest/sessions/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!dbReady)('POST /api/ingest/sessions/start', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a session and returns id + token', async () => {
    const { project } = await createOrgWithProject();
    const res = await POST(req({
      projectKey: project.projectKey,
      anonId: 'anon-1',
      pageUrl: 'https://example.com/',
      userAgent: 'Mozilla/5.0 ... Chrome/127 ...',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.ingestToken).toMatch(/^eyJ/);
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, json.sessionId));
    expect(row.anonId).toBe('anon-1');
    expect(row.projectId).toBe(project.id);
    expect(row.browser).toBe('Chrome');
  });

  it('rejects an unknown projectKey', async () => {
    const res = await POST(req({ projectKey: 'umsk_nope', anonId: 'a' }));
    expect(res.status).toBe(401);
  });

  it('rejects missing anonId', async () => {
    const { project } = await createOrgWithProject();
    const res = await POST(req({ projectKey: project.projectKey }));
    expect(res.status).toBe(400);
  });
});

// Note: when DB isn't available, vitest will report these as 'skipped', not failed.
