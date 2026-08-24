import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, count, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { applyRuleToExistingSessions, isValidRuleKind, isValidTagColor, RULE_KIND_META, type RuleKind } from '@/lib/tag-rules';

async function ownedProject(projectId: string, orgId: string) {
  const [project] = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)))
    .limit(1);
  return project ?? null;
}

export async function GET(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownedProject(id, session.orgId))) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rows = await db.select({
    id: schema.tagRules.id,
    name: schema.tagRules.name,
    kind: schema.tagRules.kind,
    value: schema.tagRules.value,
    color: schema.tagRules.color,
    enabled: schema.tagRules.enabled,
    createdAt: schema.tagRules.createdAt,
    taggedCount: count(schema.sessionTags.id),
  })
    .from(schema.tagRules)
    .leftJoin(schema.sessionTags, eq(schema.sessionTags.tagRuleId, schema.tagRules.id))
    .where(eq(schema.tagRules.projectId, id))
    .groupBy(schema.tagRules.id)
    .orderBy(schema.tagRules.createdAt);

  return NextResponse.json({ rules: rows });
}

export async function POST(req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownedProject(id, session.orgId))) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const kindIn = typeof body.kind === 'string' ? body.kind : '';
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const color = typeof body.color === 'string' ? body.color : 'green';
  if (!name || !isValidRuleKind(kindIn) || !value) {
    return NextResponse.json({ error: `name, kind (${Object.keys(RULE_KIND_META).join('|')}), value are required` }, { status: 400 });
  }
  const kind: RuleKind = kindIn;
  const meta = RULE_KIND_META[kind];
  if (meta.valueType === 'number' && !Number.isFinite(parseInt(value, 10))) {
    return NextResponse.json({ error: `value must be a number for ${kind}` }, { status: 400 });
  }
  if (meta.valueType === 'select' && !meta.options?.includes(value)) {
    return NextResponse.json({ error: `value must be one of ${meta.options?.join(', ')} for ${kind}` }, { status: 400 });
  }
  if (!isValidTagColor(color)) {
    return NextResponse.json({ error: 'invalid color' }, { status: 400 });
  }

  const [rule] = await db.insert(schema.tagRules)
    .values({ projectId: id, name, kind, value, color })
    .returning();

  // New rule — reach existing sessions immediately, not just future ones.
  const appliedCount = await applyRuleToExistingSessions(rule);

  return NextResponse.json({ rule, appliedCount }, { status: 201 });
}
