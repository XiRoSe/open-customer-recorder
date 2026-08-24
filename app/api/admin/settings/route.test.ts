import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PUT } from './route';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { signSessionJwt } from '@/lib/auth';

// Next 16's cookies() throws outside a request scope in vitest - back it
// with a test-controlled store (same pattern as the summary route tests).
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

describe.skipIf(!dbReady)('GET/PUT /api/admin/settings', () => {
  it('GET returns defaults, PUT patches and persists', async () => {
    const { org } = await createOrgWithProject();
    cookieStore.ps_session = await signSessionJwt({ orgId: org.id, email: 'admin@example.com', userId: 'u-1', name: 'Admin', userRole: 'owner' });

    let res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ summariesEnabled: true, intentEnabled: true, visualEnabled: true, profilesEnabled: true, clusteringEnabled: true });

    res = await PUT(new Request('http://localhost/api/admin/settings', {
      method: 'PUT', body: JSON.stringify({ visualEnabled: false, junk: 'ignored' }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.visualEnabled).toBe(false);

    res = await GET();
    expect((await res.json()).settings.visualEnabled).toBe(false);
  });

  it('PUT rejects a body with no valid flags', async () => {
    const { org } = await createOrgWithProject();
    cookieStore.ps_session = await signSessionJwt({ orgId: org.id, email: 'admin@example.com', userId: 'u-1', name: 'Admin', userRole: 'owner' });
    const res = await PUT(new Request('http://localhost/api/admin/settings', {
      method: 'PUT', body: JSON.stringify({ junk: true }),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated', async () => {
    expect((await GET()).status).toBe(401);
  });
});

