import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { signIngestToken } from '@/lib/ingest-token';

const dbReady = await isDbAvailable();

beforeEach(async () => { if (dbReady) await resetDb(); });

describe.skipIf(!dbReady)('POST /api/ingest/sessions/:id/end', () => {
  it('records ended_at, duration_ms, page_count', async () => {
    const { project } = await createOrgWithProject();
    const [s] = await db.insert(schema.sessions).values({
      projectId: project.id, anonId: 'a', startedAt: new Date(),
    }).returning();
    const token = await signIngestToken({ sessionId: s.id, projectId: project.id });
    const res = await POST(
      new Request(`http://localhost/api/ingest/sessions/${s.id}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-recorder-token': token },
        body: JSON.stringify({ duration_ms: 89498, page_count: 3 }),
      }),
      { params: Promise.resolve({ id: s.id }) }
    );
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.id));
    expect(row.durationMs).toBe(89498);
    expect(row.pageCount).toBe(3);
    expect(row.endedAt).toBeTruthy();
  });
});
