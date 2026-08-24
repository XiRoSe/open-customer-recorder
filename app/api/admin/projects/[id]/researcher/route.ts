// The Researcher's main endpoint: POST a question, get an SSE stream of
// meta → [queued] → tool → token → block events, closed by done (or
// busy/error). Capacity is bounded but never rejects outright until a
// dozen-deep pile-up: a second concurrent question FIFO-queues behind
// the first (see lib/researcher/graph.ts's acquireSlot) rather than
// erroring, so two admins asking at once both get real answers. The
// 60s run budget starts only once a run actually begins — queue wait
// doesn't eat into it — and the client disconnecting (tab closed, stop
// pressed with the connection dropped) aborts the graph and frees
// whatever capacity it was holding, queued or running.
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { readSessionCookie } from '@/lib/auth';
import { runResearch, acquireSlot, releaseSlot } from '@/lib/researcher/graph';
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

  const slot = acquireSlot();
  if (!slot) {
    // The queue itself is already full (a dozen-deep pile-up) — this is
    // the one case still worth an immediate, honest "busy" rather than
    // making someone wait behind that many others.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse({ type: 'busy', message: 'The Researcher is swamped right now — try again in a moment.' })));
        c.close();
      },
    });
    return new Response(stream, { headers });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let holdingSlot = slot.position === 0; // true once we actually own a running slot
      let timeout: ReturnType<typeof setTimeout> | null = null;
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

        if (slot.position > 0) {
          send({ type: 'queued', position: slot.position });
          const abortedWhileQueued = new Promise<'aborted'>((resolve) => {
            if (abort.signal.aborted) { resolve('aborted'); return; }
            abort.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
          });
          const outcome = await Promise.race([slot.ready, abortedWhileQueued]);
          if (outcome === 'ok') {
            holdingSlot = true;
          } else {
            // Whichever of the two settled first: if the OTHER one later
            // also resolves 'ok' (a slot freed up for us right as the
            // client left, or right as the 90s cap hit), hand it straight
            // back instead of leaking held capacity forever.
            slot.ready.then((v) => { if (v === 'ok') releaseSlot(); }).catch(() => {});
            send({
              type: outcome === 'aborted' ? 'error' : 'busy',
              message: outcome === 'aborted' ? 'Stopped.' : 'Still busy after a long wait — try again in a moment.',
            } as ResearcherEvent);
            return;
          }
        }

        // The 60s run budget starts only now — queue wait never eats
        // into it, so a request that waited a while still gets its full
        // window once it actually begins.
        timeout = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);

        const { content, payload } = await runResearch({
          projectId,
          question,
          historyBrief: brief,
          emit: send,
          signal: abort.signal,
        });
        if (content || payload.blocks.length > 0) {
          const messageId = await appendMessage(thread.id, 'assistant', content, payload);
          send({ type: 'done', messageId, content, payload });
        } else {
          // Aborted before anything landed — never persist a blank history
          // entry; tell the client plainly instead of silently closing.
          send({ type: 'error', message: 'Stopped.' });
        }
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
        if (timeout) clearTimeout(timeout);
        if (holdingSlot) releaseSlot();
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
