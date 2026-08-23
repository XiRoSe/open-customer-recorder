// Applying a Researcher tag draft. The agent only ever drafted; this is
// the human's click, going through the exact same validation and
// retro-apply as the Tags page — the Researcher stays literally
// read-only. On success the outcome is recorded into the thread so the
// conversation reflects what happened.
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';
import { applyRuleToExistingSessions, isValidTagColor } from '@/lib/tag-rules';
import { appendMessage } from '@/lib/researcher/threads';

const VALID_KINDS = new Set(['url_contains', 'session_count_gte']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId))).limit(1);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const color = typeof body.color === 'string' && isValidTagColor(body.color) ? body.color : 'blue';
  const threadId = typeof body.threadId === 'string' ? body.threadId : null;
  if (!name || !VALID_KINDS.has(kind) || !value) {
    return NextResponse.json({ error: 'name, kind, value are required' }, { status: 400 });
  }
  if (kind === 'session_count_gte' && !Number.isFinite(parseInt(value, 10))) {
    return NextResponse.json({ error: 'value must be a number for session_count_gte' }, { status: 400 });
  }

  const [rule] = await db.insert(schema.tagRules)
    .values({ projectId: id, name, kind, value, color })
    .returning();
  const appliedCount = await applyRuleToExistingSessions(rule);

  if (threadId) {
    // Recorded deterministically — no LLM call for a receipt.
    await appendMessage(threadId, 'assistant',
      `Applied ✓ — “${name}” is live and tagged ${appliedCount} existing session${appliedCount === 1 ? '' : 's'}; new matching sessions tag automatically.`,
      { blocks: [], citations: [], caveat: null, followups: [], footprints: [] },
    ).catch(() => { /* thread may be gone; the tag itself succeeded */ });
  }

  return NextResponse.json({ rule, appliedCount }, { status: 201 });
}
