/**
 * Admin-editable rules that tag sessions. Two kinds:
 *
 * - 'url_contains': value is a case-insensitive substring checked against
 *   every URL a session visited (Meta + mega-url-change hrefs, via
 *   lib/url-timeline.ts hrefOf). Evaluated incrementally at ingest time.
 * - 'session_count_gte': value is a stringified threshold checked against
 *   how many sessions the same anon_id has had (1-indexed, this session
 *   included). Evaluated once, at session creation.
 *
 * See docs/superpowers/specs/2026-08-11-tag-rules-system-design.md.
 */
import { db, schema } from '@/lib/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { hrefOf, type RawEvent } from '@/lib/url-timeline';

export { TAG_COLORS, isValidTagColor, type TagColor } from '@/lib/tag-colors';

export interface TagRule {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  value: string;
  color: string;
  enabled: boolean;
}

/** Case-insensitive substring match against a URL. */
export function matchesUrlContains(ruleValue: string, href: string): boolean {
  return href.toLowerCase().includes(ruleValue.toLowerCase());
}

/** Does `sessionNumber` (1-indexed among the same anon_id's sessions) meet
 * a session_count_gte rule's threshold? */
export function matchesSessionCount(ruleValue: string, sessionNumber: number): boolean {
  const threshold = parseInt(ruleValue, 10);
  return Number.isFinite(threshold) && sessionNumber >= threshold;
}

/**
 * Which enabled url_contains rules does this ingest batch match — checked
 * against the page-url param and every event's href in one pass.
 */
export function matchingUrlContainsRules(
  rules: TagRule[],
  pageUrl: string | null,
  hrefs: (string | null)[],
): TagRule[] {
  const candidates = rules.filter((r) => r.enabled && r.kind === 'url_contains');
  if (candidates.length === 0) return [];
  const urls = [pageUrl, ...hrefs].filter((h): h is string => !!h);
  if (urls.length === 0) return [];
  return candidates.filter((r) => urls.some((u) => matchesUrlContains(r.value, u)));
}

/** Tag a session with the given rules. Idempotent — safe to call with
 * rules the session is already tagged with. */
export async function tagSession(sessionId: string, ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await db.insert(schema.sessionTags)
    .values(ruleIds.map((tagRuleId) => ({ sessionId, tagRuleId })))
    .onConflictDoNothing();
}

/**
 * Apply a single rule to every existing session in its project not
 * already tagged with it. Returns how many sessions were newly tagged.
 * Called right after a rule is created or re-enabled, so old sessions
 * aren't blind to a new rule.
 */
export async function applyRuleToExistingSessions(rule: TagRule): Promise<number> {
  const matched = await applyRuleInner(rule);
  if (matched > 0) {
    // Retroactive tagging mutates history — stale rollup hours must be
    // rebuilt or the all-time tag counts silently disagree with raw.
    const { invalidateRollups } = await import('./rollups');
    await invalidateRollups(rule.projectId).catch((e) =>
      console.warn('[tag-rules] rollup invalidation failed', e instanceof Error ? e.message : e));
  }
  return matched;
}

async function applyRuleInner(rule: TagRule): Promise<number> {
  if (rule.kind === 'session_count_gte') {
    const threshold = parseInt(rule.value, 10);
    if (!Number.isFinite(threshold)) return 0;
    const result = await db.execute<{ session_id: string }>(sql`
      INSERT INTO session_tags (session_id, tag_rule_id)
      SELECT s.id, ${rule.id}::uuid
      FROM (
        SELECT id, row_number() OVER (PARTITION BY anon_id ORDER BY started_at) AS rn
        FROM sessions
        WHERE project_id = ${rule.projectId}::uuid
      ) s
      WHERE s.rn >= ${threshold}
      ON CONFLICT DO NOTHING
      RETURNING session_id
    `);
    const rows = Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows ?? [];
    return rows.length;
  }

  if (rule.kind === 'url_contains') {
    const tagged = await db.select({ sessionId: schema.sessionTags.sessionId })
      .from(schema.sessionTags)
      .where(eq(schema.sessionTags.tagRuleId, rule.id));
    const taggedIds = new Set(tagged.map((r) => r.sessionId));

    const candidates = await db.select({ id: schema.sessions.id, blobData: schema.sessions.blobData })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.projectId, rule.projectId), gt(schema.sessions.blobBytes, 0)));

    let matched = 0;
    for (const row of candidates) {
      if (taggedIds.has(row.id)) continue;
      let plain: Buffer;
      try {
        plain = gunzipSync(row.blobData);
      } catch {
        continue;
      }
      let hit = false;
      for (const line of plain.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let e: RawEvent;
        try { e = JSON.parse(line); } catch { continue; }
        const href = hrefOf(e);
        if (href && matchesUrlContains(rule.value, href)) { hit = true; break; }
      }
      if (hit) {
        await tagSession(row.id, [rule.id]);
        matched++;
      }
    }
    return matched;
  }

  return 0;
}
