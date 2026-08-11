/**
 * Batched tag lookup for rendering — one query for every session shown on
 * a page, rather than one per row. Mirrors the lib/session-views.ts
 * viewedSessionIds pattern.
 */
import { db, schema } from '@/lib/db';
import { eq, inArray } from 'drizzle-orm';

export interface SessionTag { id: string; name: string; color: string }

/** Tags for each of the given sessions, keyed by session id. Sessions
 * with no tags are simply absent from the map. */
export async function tagsForSessions(sessionIds: string[]): Promise<Map<string, SessionTag[]>> {
  const map = new Map<string, SessionTag[]>();
  if (sessionIds.length === 0) return map;
  const rows = await db.select({
    sessionId: schema.sessionTags.sessionId,
    ruleId: schema.tagRules.id,
    name: schema.tagRules.name,
    color: schema.tagRules.color,
  })
    .from(schema.sessionTags)
    .innerJoin(schema.tagRules, eq(schema.sessionTags.tagRuleId, schema.tagRules.id))
    .where(inArray(schema.sessionTags.sessionId, sessionIds));
  for (const r of rows) {
    const list = map.get(r.sessionId) ?? [];
    list.push({ id: r.ruleId, name: r.name, color: r.color });
    map.set(r.sessionId, list);
  }
  return map;
}
