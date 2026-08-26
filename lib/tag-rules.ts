/**
 * Server-side tag-rule evaluation: applying rules to sessions already in
 * the database. Kind metadata and the pure matching predicates live in
 * lib/tag-rule-kinds.ts (no db import, so client components can use them
 * too) — re-exported here for every existing server-side importer.
 *
 * See docs/superpowers/specs/2026-08-11-tag-rules-system-design.md.
 */
import { db, schema } from '@/lib/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { hrefOf, type RawEvent } from '@/lib/url-timeline';
import { deviceOf } from '@/lib/device';
import { categorizeSource } from '@/lib/traffic-source';
import { matchesUrlContains, matchesDeviceIs, matchesSourceIs, type TagRule } from '@/lib/tag-rule-kinds';

export * from '@/lib/tag-rule-kinds';

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
 * Called right after a rule is created, re-enabled, or edited, so old
 * sessions aren't blind to what changed.
 */
export async function applyRuleToExistingSessions(rule: TagRule): Promise<number> {
  return applyRuleInner(rule);
}

function rowCount(result: unknown): number {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  return rows.length;
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
    return rowCount(result);
  }

  if (rule.kind === 'browser_is') {
    const result = await db.execute(sql`
      INSERT INTO session_tags (session_id, tag_rule_id)
      SELECT id, ${rule.id}::uuid FROM sessions
      WHERE project_id = ${rule.projectId}::uuid AND lower(browser) = lower(${rule.value})
      ON CONFLICT DO NOTHING
      RETURNING session_id
    `);
    return rowCount(result);
  }

  if (rule.kind === 'country_is') {
    const result = await db.execute(sql`
      INSERT INTO session_tags (session_id, tag_rule_id)
      SELECT id, ${rule.id}::uuid FROM sessions
      WHERE project_id = ${rule.projectId}::uuid AND lower(country) = lower(${rule.value})
      ON CONFLICT DO NOTHING
      RETURNING session_id
    `);
    return rowCount(result);
  }

  if (rule.kind === 'referrer_contains') {
    const pattern = `%${rule.value}%`;
    const result = await db.execute(sql`
      INSERT INTO session_tags (session_id, tag_rule_id)
      SELECT id, ${rule.id}::uuid FROM sessions
      WHERE project_id = ${rule.projectId}::uuid AND referrer ILIKE ${pattern}
      ON CONFLICT DO NOTHING
      RETURNING session_id
    `);
    return rowCount(result);
  }

  if (rule.kind === 'duration_gte') {
    const threshold = parseInt(rule.value, 10);
    if (!Number.isFinite(threshold)) return 0;
    const result = await db.execute(sql`
      INSERT INTO session_tags (session_id, tag_rule_id)
      SELECT id, ${rule.id}::uuid FROM sessions
      WHERE project_id = ${rule.projectId}::uuid AND duration_ms >= ${threshold * 1000}
      ON CONFLICT DO NOTHING
      RETURNING session_id
    `);
    return rowCount(result);
  }

  if (rule.kind === 'device_is' || rule.kind === 'source_is') {
    const tagged = await db.select({ sessionId: schema.sessionTags.sessionId })
      .from(schema.sessionTags)
      .where(eq(schema.sessionTags.tagRuleId, rule.id));
    const taggedIds = new Set(tagged.map((r) => r.sessionId));

    const candidates = await db.select({
      id: schema.sessions.id,
      userAgent: schema.sessions.userAgent,
      referrer: schema.sessions.referrer,
      pageUrl: schema.sessions.pageUrl,
    }).from(schema.sessions).where(eq(schema.sessions.projectId, rule.projectId));

    const toTag: string[] = [];
    for (const row of candidates) {
      if (taggedIds.has(row.id)) continue;
      const hit = rule.kind === 'device_is'
        ? matchesDeviceIs(rule.value, deviceOf(row.userAgent))
        : matchesSourceIs(rule.value, categorizeSource(row.referrer, row.pageUrl));
      if (hit) toTag.push(row.id);
    }
    if (toTag.length === 0) return 0;
    await db.insert(schema.sessionTags)
      .values(toTag.map((sessionId) => ({ sessionId, tagRuleId: rule.id })))
      .onConflictDoNothing();
    return toTag.length;
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
