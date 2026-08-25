// Researcher thread persistence — our own tables, not a checkpointer:
// the History view needs titles, findings, and instant recall of the
// full render payload anyway, and the model only ever sees a trimmed
// text brief of the recent turns (ctx is 4096/slot).
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import type { AssistantPayload, ResearcherBlock, ThreadMessage, ThreadSummary } from './types';

/** A few words of the first question become the thread's name. */
export function titleFromQuestion(q: string): string {
  const words = q.trim().replace(/\s+/g, ' ').split(' ').slice(0, 6).join(' ');
  const t = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return t || 'New research';
}

export async function ensureThread(projectId: string, userId: string, threadId: string | null, question: string):
  Promise<{ id: string; title: string; isNew: boolean }> {
  if (threadId) {
    const [t] = await db.select().from(schema.researcherThreads)
      .where(and(
        eq(schema.researcherThreads.id, threadId),
        eq(schema.researcherThreads.projectId, projectId),
        eq(schema.researcherThreads.userId, userId),
      )).limit(1);
    if (t) return { id: t.id, title: t.title, isNew: false };
  }
  const [created] = await db.insert(schema.researcherThreads).values({
    projectId, userId, title: titleFromQuestion(question),
  }).returning();
  return { id: created.id, title: created.title, isNew: true };
}

export async function appendMessage(threadId: string, role: 'user' | 'assistant', content: string, payload: AssistantPayload | null = null): Promise<string> {
  const [row] = await db.insert(schema.researcherMessages).values({
    threadId, role, content, payload: payload ?? undefined,
  }).returning();
  await db.update(schema.researcherThreads)
    .set({ lastMessageAt: new Date() })
    .where(eq(schema.researcherThreads.id, threadId));
  return row.id;
}

function fmtDur(ms: number | null): string {
  if (ms == null) return '?';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}` : `${s}s`;
}

/**
 * A compact [showed: ...] context line derived from an answer's payload.
 * The prose alone loses everything that matters for follow-ups — session
 * UUIDs, segment names, the exact figures — because those live in the
 * blocks, not the text. This line puts them back into the model's memory
 * so "watch the first one" / "tell me more about that segment" can
 * actually resolve. Pure and exported for tests.
 */
export function payloadContext(payload: AssistantPayload | null): string {
  if (!payload) return '';
  const parts: string[] = [];
  for (const b of (payload.blocks ?? []) as ResearcherBlock[]) {
    if (b.type === 'evidence') {
      const rows = b.rows.slice(0, 3).map((r) => `${r.label}=${r.display ?? r.value}`).join(', ');
      parts.push(`${b.title}: ${rows}`);
    } else if (b.type === 'sessions') {
      const items = b.items.slice(0, 2).map((i) =>
        `${i.id} (${fmtDur(i.durationMs)}${i.browser ? `, ${i.browser}` : ''}${i.frustrated ? ', frustrated' : ''})`);
      const more = b.items.length > 2 ? ` +${b.items.length - 2} more` : '';
      parts.push(`sessions: ${items.join('; ')}${more}`);
    } else if (b.type === 'table') {
      parts.push(`table "${b.title}" (${b.rows.length} rows)`);
    } else if (b.type === 'tagDraft') {
      parts.push(`tag draft "${b.name}": ${b.kind}=${b.value} (~${b.matchCount} sessions)`);
    } else if (b.type === 'chart') {
      parts.push(`chart "${b.title}" ${b.windowNote}`);
    } else if (b.type === 'clusterMap') {
      const dim = b.dims.find((d) => d.dimension === b.initialDimension) ?? b.dims[0];
      const segs = dim ? dim.segments.slice(0, 4).map((s) => `${s.name} (${s.size})`).join(', ') : '';
      parts.push(`segments${dim ? ` [${dim.dimension}]` : ''}: ${segs}`);
    } else if (b.type === 'analysis') {
      parts.push(`analysis "${b.title}"`);
    }
  }
  if (payload.link?.href) parts.push(`view: ${payload.link.href}`);
  if (parts.length === 0) return '';
  return `[showed: ${parts.join('; ')}]`.slice(0, 500);
}

/**
 * Compact text rendering of the last turns — the model's only memory.
 * Assistant turns carry their [showed: ...] context line so follow-ups
 * can resolve pronouns to real segment names, session ids and figures.
 * Oldest turns drop first when the total exceeds the character budget
 * (ctx is 4096/slot — this must stay small).
 */
export async function historyBrief(threadId: string, maxMessages = 10, maxChars = 1800): Promise<string> {
  const rows = await db.select({
    role: schema.researcherMessages.role,
    content: schema.researcherMessages.content,
    payload: schema.researcherMessages.payload,
  }).from(schema.researcherMessages)
    .where(eq(schema.researcherMessages.threadId, threadId))
    .orderBy(desc(schema.researcherMessages.createdAt))
    .limit(maxMessages);
  const lines = rows.reverse().map((m) => {
    if (m.role === 'user') return `User: ${m.content.replace(/\s+/g, ' ').slice(0, 240)}`;
    const prose = m.content.replace(/\s+/g, ' ').slice(0, 400);
    const ctx = payloadContext((m.payload ?? null) as AssistantPayload | null);
    return `Researcher: ${prose}${ctx ? `\n  ${ctx}` : ''}`;
  });
  // Trim from the front (oldest) until the budget holds.
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  return lines.join('\n');
}

export async function listThreads(projectId: string, userId: string, limit = 30): Promise<ThreadSummary[]> {
  interface Row extends Record<string, unknown> {
    id: string; title: string; last_message_at: string; finding: string | null;
  }
  const res = await db.execute<Row>(sql`
    SELECT t.id, t.title, t.last_message_at,
           (SELECT m.content FROM researcher_messages m
            WHERE m.thread_id = t.id AND m.role = 'assistant'
            ORDER BY m.created_at DESC LIMIT 1) AS finding
    FROM researcher_threads t
    WHERE t.project_id = ${projectId}::uuid AND t.user_id = ${userId}::uuid
    ORDER BY t.last_message_at DESC
    LIMIT ${limit}
  `);
  const rows: Row[] = Array.isArray(res) ? res : (res as unknown as { rows: Row[] }).rows ?? [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    finding: r.finding ? r.finding.split('\n')[0].slice(0, 140) : null,
  }));
}

/** Public, unauthenticated lookup for the share page — the token IS the
 * capability, so this intentionally skips the userId/projectId check
 * that every other reader here enforces. */
export async function threadByShareToken(token: string): Promise<{ id: string; projectId: string; title: string; messages: ThreadMessage[] } | null> {
  const [t] = await db.select({ id: schema.researcherThreads.id, projectId: schema.researcherThreads.projectId, title: schema.researcherThreads.title })
    .from(schema.researcherThreads)
    .where(eq(schema.researcherThreads.shareToken, token)).limit(1);
  if (!t) return null;
  const rows = await db.select().from(schema.researcherMessages)
    .where(eq(schema.researcherMessages.threadId, t.id))
    .orderBy(asc(schema.researcherMessages.createdAt));
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: m.content,
      payload: (m.payload ?? null) as AssistantPayload | null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function threadMessages(projectId: string, userId: string, threadId: string): Promise<ThreadMessage[] | null> {
  const [t] = await db.select({ id: schema.researcherThreads.id }).from(schema.researcherThreads)
    .where(and(
      eq(schema.researcherThreads.id, threadId),
      eq(schema.researcherThreads.projectId, projectId),
      eq(schema.researcherThreads.userId, userId),
    )).limit(1);
  if (!t) return null;
  const rows = await db.select().from(schema.researcherMessages)
    .where(eq(schema.researcherMessages.threadId, threadId))
    .orderBy(asc(schema.researcherMessages.createdAt));
  return rows.map((m) => ({
    id: m.id,
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.content,
    payload: (m.payload ?? null) as AssistantPayload | null,
    createdAt: m.createdAt.toISOString(),
  }));
}
