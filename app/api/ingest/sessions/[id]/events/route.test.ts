import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { signIngestToken } from '@/lib/ingest-token';
import { gzipSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbReady = await isDbAvailable();

let tmp: string;
beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'events-'));
  process.env.BLOB_DIR = tmp;
});

async function setup() {
  const { project } = await createOrgWithProject();
  const [s] = await db.insert(schema.sessions).values({
    projectId: project.id, anonId: 'a', startedAt: new Date(), blobPath: `sessions/x.ndjson.gz`,
  }).returning();
  const token = await signIngestToken({ sessionId: s.id, projectId: project.id });
  return { sessionId: s.id, token };
}

function req(id: string, body: Buffer, headers: Record<string,string>) {
  return new Request(`http://localhost/api/ingest/sessions/${id}/events`, {
    method: 'POST', body: new Uint8Array(body), headers,
  });
}

describe.skipIf(!dbReady)('POST /api/ingest/sessions/:id/events', () => {
  it('accepts a batch and updates eventCount', async () => {
    const { sessionId, token } = await setup();
    const events = '{"t":1,"d":"a"}\n{"t":2,"d":"b"}\n';
    const body = gzipSync(Buffer.from(events));
    const res = await POST(
      req(sessionId, body, { 'content-encoding': 'gzip', 'x-recorder-token': token }),
      { params: Promise.resolve({ id: sessionId }) }
    );
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(row.eventCount).toBe(2);
    expect(row.blobBytes).toBe(body.length);
  });

  it('rejects with no token', async () => {
    const { sessionId } = await setup();
    const res = await POST(
      req(sessionId, Buffer.from('x'), {}),
      { params: Promise.resolve({ id: sessionId }) }
    );
    expect(res.status).toBe(401);
  });

  it('rejects with token bound to a different session', async () => {
    const { sessionId } = await setup();
    const otherToken = await signIngestToken({ sessionId: 'other', projectId: 'p' });
    const res = await POST(
      req(sessionId, gzipSync(Buffer.from('x')), { 'content-encoding': 'gzip', 'x-recorder-token': otherToken }),
      { params: Promise.resolve({ id: sessionId }) }
    );
    expect(res.status).toBe(403);
  });
});

// Note: when DB isn't available, vitest will report these as 'skipped', not failed.
