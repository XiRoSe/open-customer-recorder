// Researcher thread persistence — our own tables, not a checkpointer:
// the History view needs titles, findings, and instant recall of the
// full render payload anyway, and the model only ever sees a trimmed
// text brief of the recent turns (ctx is 4096/slot).
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import type { AssistantPayload, ThreadMessage, ThreadSummary } from './types';

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

/** Compact text rendering of the last turns — the model's only memory. */
export async function historyBrief(threadId: string, maxMessages = 6): Promise<string> {
  const rows = await db.select({
    role: schema.researcherMessages.role,
    content: schema.researcherMessages.content,
  }).from(schema.researcherMessages)
    .where(eq(schema.researcherMessages.threadId, threadId))
    .orderBy(desc(schema.researcherMessages.createdAt))
    .limit(maxMessages);
  return rows.reverse()
    .map((m) => `${m.role === 'user' ? 'User' : 'Researcher'}: ${m.content.replace(/\s+/g, ' ').slice(0, 220)}`)
    .join('\n');
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
