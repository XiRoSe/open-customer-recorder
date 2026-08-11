/**
 * Manually (re-)apply a rule to every existing session in its project.
 * Used for the one-time seed-rule backfill right after this feature's
 * migration lands (see docs/superpowers/specs/2026-08-11-tag-rules-system-design.md)
 * — create/enable already trigger this automatically, so day-to-day this
 * endpoint mostly exists for that bootstrap step.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { applyRuleToExistingSessions } from '@/lib/tag-rules';

export async function POST(_req: NextRequest | Request, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, ruleId } = await ctx.params;

  const [row] = await db.select({ rule: schema.tagRules })
    .from(schema.tagRules)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tagRules.projectId))
    .where(and(
      eq(schema.tagRules.id, ruleId),
      eq(schema.tagRules.projectId, id),
      eq(schema.projects.orgId, session.orgId),
    ))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const appliedCount = await applyRuleToExistingSessions(row.rule);
  return NextResponse.json({ appliedCount });
}
