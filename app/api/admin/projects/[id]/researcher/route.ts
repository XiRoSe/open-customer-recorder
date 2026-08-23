// The Researcher's main endpoint: POST a question, get an SSE stream of
// meta → tool → block → token events, closed by done (or busy/error).
// The whole run is bounded: one interactive slot, 60s hard abort, and
// the client disconnecting aborts the graph (and the LLM call under it).
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';
import { runResearch, tryAcquireSlot, releaseSlot } from '@/lib/researcher/graph';
import { ensureThread, appendMessage, historyBrief } from '@/lib/researcher/threads';
import type { ResearcherEvent } from '@/lib/researcher/types';

export const dynamic = 'force-dynamic';

const RUN_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 15_000;

const sse = (e: ResearcherEvent) => `data: ${JSON.stringify(e)}\n\n`;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return new Response('unauthorized', { status: 401 });
  const { id: projectId } = await ctx.params;
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, session.orgId))).limit(1);
  if (!project) return new Response('not found', { status: 404 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : '';
  const threadIdIn = typeof body?.threadId === 'string' ? body.threadId : null;
  if (!question) return new Response('question required', { status: 400 });

  const headers = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };

  if (!tryAcquireSlot()) {
    // Honest and immediate — the drawer offers a retry.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse({ type: 'busy', message: 'The Researcher is helping someone else right now — try again in a moment.' })));
        c.close();
      },
    });
    return new Response(stream, { headers });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  // Client gone (tab closed, stop pressed with connection drop) → stop
  // the graph and free the LLM slot.
  req.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: ResearcherEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(sse(e))); } catch { closed = true; }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; }
      }, HEARTBEAT_MS);

      try {
        const thread = await ensureThread(projectId, session.userId, threadIdIn, question);
        send({ type: 'meta', threadId: thread.id, title: thread.title });
        const brief = thread.isNew ? '' : await historyBrief(thread.id);
        await appendMessage(thread.id, 'user', question);

        const { content, payload } = await runResearch({
          projectId,
          question,
          historyBrief: brief,
          emit: send,
          signal: abort.signal,
        });
        const messageId = await appendMessage(thread.id, 'assistant', content, payload);
        send({ type: 'done', messageId, content, payload });
      } catch (e) {
        console.warn('[researcher] run failed', e instanceof Error ? e.message : e);
        send({
          type: 'error',
          message: abort.signal.aborted
            ? 'Stopped.'
            : 'Something went wrong mid-research — ask again and I will retry.',
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        releaseSlot();
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers });
}
