import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { applyRuleToExistingSessions, isValidTagColor } from '@/lib/tag-rules';

// Kind is intentionally immutable after creation — it determines which
// evaluation lifecycle (ingest / creation / duration) the rule belongs
// to, so changing it would silently strand already-matched sessions
// tagged under the old semantics. Delete and recreate for that.

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
  const hasName = typeof body.name === 'string' && body.name.trim().length > 0;
  const hasValue = typeof body.value === 'string' && body.value.trim().length > 0;
  if (!hasEnabled && !hasColor && !hasName && !hasValue) {
    return NextResponse.json({ error: 'enabled, color, name, and/or value required' }, { status: 400 });
  }
  if (hasColor && !isValidTagColor(body.color as string)) {
    return NextResponse.json({ error: 'invalid color' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (hasEnabled) patch.enabled = body.enabled;
  if (hasColor) patch.color = body.color;
  if (hasName) patch.name = (body.name as string).trim();
  if (hasValue) patch.value = (body.value as string).trim();

  const [rule] = await db.update(schema.tagRules)
    .set(patch)
    .where(eq(schema.tagRules.id, ruleId))
    .returning();

  // Re-enabling, or changing what it matches on, may newly qualify
  // sessions that predate the change — reach them the same way a
  // brand-new rule does.
  const enabledNowOrAlready = hasEnabled ? Boolean(body.enabled) : existing.enabled;
  let appliedCount = 0;
  if (enabledNowOrAlready && ((hasEnabled && body.enabled && !existing.enabled) || hasValue)) {
    appliedCount = await applyRuleToExistingSessions(rule);
  }

  return NextResponse.json({ rule, appliedCount });
}

export async function DELETE(_req: NextRequest | Request, ctx: { params: Promise<{ id: string; ruleId: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, ruleId } = await ctx.params;
  const existing = await ownedRule(id, ruleId, session.orgId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Cascades to session_tags via FK — every badge this rule ever applied
  // disappears with it. Confirmed client-side before this is ever called.
  await db.delete(schema.tagRules).where(eq(schema.tagRules.id, ruleId));

  return NextResponse.json({ ok: true });
}
