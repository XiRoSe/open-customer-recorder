import { describe, it, expect, beforeEach } from 'vitest';
import { GET } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { signSessionJwt } from '@/lib/auth';

const dbReady = await isDbAvailable();

beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  process.env.JWT_SECRET = 'jwt-secret-must-be-at-least-32-bytes-aaaa';
});

describe.skipIf(!dbReady)('GET /api/admin/projects/:id/sessions', () => {
  it('returns sessions for the project, scoped to org', async () => {
    const { org, project } = await createOrgWithProject();
    await db.insert(schema.sessions).values([
      { projectId: project.id, anonId: 'a1', startedAt: new Date(), durationMs: 5000, pageUrl: '/p1' },
      { projectId: project.id, anonId: 'a2', startedAt: new Date(), durationMs: 3000, pageUrl: '/p2' },
    ]);
    const token = await signSessionJwt({ orgId: org.id, email: 'admin@example.com', userId: 'u-1', name: 'Admin', userRole: 'owner' });
    const res = await GET(
      new Request(`http://localhost/api/admin/projects/${project.id}/sessions`, {
        headers: { cookie: `ps_session=${token}` },
      }),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions.length).toBe(2);
    expect(json.total).toBe(2);
  });

  it('rejects unauthenticated', async () => {
    const { project } = await createOrgWithProject();
    const res = await GET(
      new Request(`http://localhost/api/admin/projects/${project.id}/sessions`),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(401);
  });
});
