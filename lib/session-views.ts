/**
 * Per-admin "viewed" tracking for recording sessions.
 *
 * Each admin has independent viewed/unviewed state, keyed by their email
 * (auth is env-based; there's no users table). A session is "viewed" by an
 * admin when a row exists in session_views for (sessionId, adminEmail).
 */
import { db, schema } from '@/lib/db';
import { and, eq, inArray } from 'drizzle-orm';

/** Mark a single session viewed by an admin. Idempotent (safe to reopen). */
export async function markSessionViewed(sessionId: string, adminEmail: string): Promise<void> {
  await db.insert(schema.sessionViews)
    .values({ sessionId, adminEmail })
    .onConflictDoNothing();
}

/**
 * Which of the given sessions has this admin already viewed?
 * Returns a Set of session ids so callers can compute per-row unread state.
 */
export async function viewedSessionIds(sessionIds: string[], adminEmail: string): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await db.select({ sessionId: schema.sessionViews.sessionId })
    .from(schema.sessionViews)
    .where(and(
      eq(schema.sessionViews.adminEmail, adminEmail),
      inArray(schema.sessionViews.sessionId, sessionIds),
    ));
  return new Set(rows.map((r) => r.sessionId));
}

/**
 * Mark every session in a project viewed by this admin. Backs the
 * "Mark all as viewed" button. Idempotent via the unique (session, admin)
 * index. Org ownership is enforced by the caller before invoking this.
 */
export async function markProjectSessionsViewed(projectId: string, adminEmail: string): Promise<void> {
  const sessions = await db.select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, projectId));
  if (sessions.length === 0) return;
  await db.insert(schema.sessionViews)
    .values(sessions.map((s) => ({ sessionId: s.id, adminEmail })))
    .onConflictDoNothing();
}
