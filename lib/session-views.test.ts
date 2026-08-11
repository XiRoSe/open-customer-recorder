import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { markSessionViewed, viewedSessionIds, markProjectSessionsViewed } from './session-views';

const dbReady = await isDbAvailable();

const A = 'alice@example.com';
const B = 'bob@example.com';

async function makeSession(projectId: string, anonId: string) {
  const [s] = await db.insert(schema.sessions).values({
    projectId, anonId, startedAt: new Date(), eventCount: 1,
  }).returning();
  return s;
}

beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
});

describe.skipIf(!dbReady)('session-views', () => {
  describe('markSessionViewed', () => {
    it('records one view row for the admin and is idempotent', async () => {
      const { project } = await createOrgWithProject();
      const s = await makeSession(project.id, 'a1');

      await markSessionViewed(s.id, A);
      await markSessionViewed(s.id, A); // reopening must not duplicate

      const rows = await db.select().from(schema.sessionViews)
        .where(eq(schema.sessionViews.sessionId, s.id));
      expect(rows.length).toBe(1);
      expect(rows[0].adminEmail).toBe(A);
    });
  });

  describe('viewedSessionIds', () => {
    it('returns only the sessions the given admin has viewed', async () => {
      const { project } = await createOrgWithProject();
      const s1 = await makeSession(project.id, 'a1');
      const s2 = await makeSession(project.id, 'a2');

      await markSessionViewed(s1.id, A); // A viewed s1
      await markSessionViewed(s2.id, B); // B viewed s2

      const seenByA = await viewedSessionIds([s1.id, s2.id], A);
      expect(seenByA.has(s1.id)).toBe(true);
      expect(seenByA.has(s2.id)).toBe(false); // B's view must not leak to A
    });

    it('returns an empty set for no session ids', async () => {
      const seen = await viewedSessionIds([], A);
      expect(seen.size).toBe(0);
    });
  });

  describe('markProjectSessionsViewed', () => {
    it('marks every project session viewed for the admin, idempotently', async () => {
      const { project } = await createOrgWithProject();
      const s1 = await makeSession(project.id, 'a1');
      const s2 = await makeSession(project.id, 'a2');

      await markSessionViewed(s1.id, A); // already viewed one
      await markProjectSessionsViewed(project.id, A);
      await markProjectSessionsViewed(project.id, A); // idempotent

      const seen = await viewedSessionIds([s1.id, s2.id], A);
      expect(seen.size).toBe(2);

      const rows = await db.select().from(schema.sessionViews)
        .where(eq(schema.sessionViews.adminEmail, A));
      expect(rows.length).toBe(2); // no duplicate for s1
    });

    it('does not affect another admin', async () => {
      const { project } = await createOrgWithProject();
      const s1 = await makeSession(project.id, 'a1');

      await markProjectSessionsViewed(project.id, A);

      const seenByB = await viewedSessionIds([s1.id], B);
      expect(seenByB.size).toBe(0);
    });
  });
});
