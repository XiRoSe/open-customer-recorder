import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { signIngestToken } from '@/lib/ingest-token';

const dbReady = await isDbAvailable();

beforeEach(async () => { if (dbReady) await resetDb(); });

async function setup() {
  const { project } = await createOrgWithProject();
  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id, anonId: 'a', startedAt: new Date(),
  }).returning();
  const token = await signIngestToken({ sessionId: s.id, projectId: project.id });
  return { sessionId: s.id, token };
}

describe.skipIf(!dbReady)('POST /api/ingest/sessions/:id/identify', () => {
  it('updates user_id, email, displayName', async () => {
    const { sessionId, token } = await setup();
    const res = await POST(
      new Request(`http://localhost/api/ingest/sessions/${sessionId}/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-recorder-token': token },
        body: JSON.stringify({ userId: 'u-1', email: 'jordan@example.com', displayName: 'Jordan' }),
      }),
      { params: Promise.resolve({ id: sessionId }) }
    );
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(row.userId).toBe('u-1');
    expect(row.email).toBe('jordan@example.com');
    expect(row.displayName).toBe('Jordan');
  });
});
