import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { applyRuleToExistingSessions, isValidTagColor } from '@/lib/tag-rules';

async function ownedRule(projectId: string, ruleId: string, orgId: string) {
  const [row] = await db.select({ rule: schema.tagRules })
    .from(schema.tagRules)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tagRules.projectId))
    .where(and(
      eq(schema.tagRules.id, ruleId),
      eq(schema.tagRules.projectId, projectId),
      eq(schema.projects.orgId, orgId),
    ))
    .limit(1);
  return row?.rule ?? null;
}

export async function PATCH(req: NextRequest | Request, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, ruleId } = await ctx.params;
  const existing = await ownedRule(id, ruleId, session.orgId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const hasEnabled = typeof body.enabled === 'boolean';
  const hasColor = typeof body.color === 'string';
  if (!hasEnabled && !hasColor) {
    return NextResponse.json({ error: 'enabled (boolean) and/or color (string) required' }, { status: 400 });
  }
  if (hasColor && !isValidTagColor(body.color as string)) {
    return NextResponse.json({ error: 'invalid color' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (hasEnabled) patch.enabled = body.enabled;
  if (hasColor) patch.color = body.color;

  const [rule] = await db.update(schema.tagRules)
    .set(patch)
    .where(eq(schema.tagRules.id, ruleId))
    .returning();

  // Re-enabling — sessions may have qualified while it was off.
  let appliedCount = 0;
  if (hasEnabled && body.enabled && !existing.enabled) {
    appliedCount = await applyRuleToExistingSessions(rule);
  }

  return NextResponse.json({ rule, appliedCount });
}
