/**
 * Anon_ids excluded from recording — see lib/db/schema.ts excludedAnonIds
 * and the ingest-time enforcement in app/api/ingest/v2/events/route.ts.
 */
import { db, schema } from '@/lib/db';
import { and, eq, inArray } from 'drizzle-orm';

/** Is this anon_id excluded from recording for this project? Checked on
 * every ingest POST — cheap indexed lookup on the unique (project, anon)
 * pair. */
export async function isExcluded(projectId: string, anonId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.excludedAnonIds.id })
    .from(schema.excludedAnonIds)
    .where(and(eq(schema.excludedAnonIds.projectId, projectId), eq(schema.excludedAnonIds.anonId, anonId)))
    .limit(1);
  return !!row;
}

/** Add an anon_id to the exclusion list. Idempotent. */
export async function excludeUser(projectId: string, anonId: string): Promise<void> {
  await db.insert(schema.excludedAnonIds)
    .values({ projectId, anonId })
    .onConflictDoNothing();
}

/** Remove an anon_id from the exclusion list. */
export async function unexcludeUser(projectId: string, anonId: string): Promise<void> {
  await db.delete(schema.excludedAnonIds)
    .where(and(eq(schema.excludedAnonIds.projectId, projectId), eq(schema.excludedAnonIds.anonId, anonId)));
}

/** Which of the given anon_ids are excluded, for rendering the Users
 * tab's exclude/excluded toggle without a query per row. */
export async function excludedAnonIdsAmong(projectId: string, anonIds: string[]): Promise<Set<string>> {
  if (anonIds.length === 0) return new Set();
  const rows = await db.select({ anonId: schema.excludedAnonIds.anonId })
    .from(schema.excludedAnonIds)
    .where(and(eq(schema.excludedAnonIds.projectId, projectId), inArray(schema.excludedAnonIds.anonId, anonIds)));
  return new Set(rows.map((r) => r.anonId));
}
