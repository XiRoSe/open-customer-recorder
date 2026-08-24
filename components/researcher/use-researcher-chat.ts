'use client';

// The Researcher's client state machine, shared by every surface
// (drawer, full-screen workspace, read-only share). Owns the SSE
// stream parsing, the live run, thread identity, observations, and the
// history list — surfaces only compose and style.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantPayload, Footprint, ResearcherBlock, ResearcherEvent, ThreadSummary } from '@/lib/researcher/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload: AssistantPayload | null;
}

export interface LiveRun {
  statusLabel: string | null;
  footprints: Footprint[];
  blocks: ResearcherBlock[];
  text: string;
  composing: boolean;
  interrupted: boolean;
  error: string | null;
  question: string;
}

export interface Observation { text: string; strong: string; question: string }

export function greetingWord(): string {
  const h = new Date().getHours();
  // 0–5 counts as evening — "Morning" at 1am reads wrong.
  return h < 6 ? 'Evening' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

export function useResearcherChat(projectId: string | null, opts?: { initialThreadId?: string | null }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef<LiveRun | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialLoadedRef = useRef(false);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Project switch resets the conversation (threads are per-project).
  useEffect(() => {
    setThreadId(null); setThreadTitle(null); setMessages([]); setLive(null);
    setObservations(null); setThreads(null);
  }, [projectId]);

  const loadObservations = useCallback(() => {
    if (!projectId || observations !== null) return;
    fetch(`/api/admin/projects/${projectId}/researcher/observations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setObservations(j?.observations ?? []))
      .catch(() => setObservations([]));
  }, [projectId, observations]);

  const loadThreads = useCallback(() => {
    if (!projectId) return;
    fetch(`/api/admin/projects/${projectId}/researcher/threads`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setThreads(j?.threads ?? []))
      .catch(() => setThreads([]));
  }, [projectId]);

  const openThreadById = useCallback(async (id: string, title?: string) => {
    if (!projectId) return false;
    try {
      const res = await fetch(`/api/admin/projects/${projectId}/researcher/threads/${id}`);
      if (!res.ok) return false;
      const j = await res.json() as { messages: { id: string; role: 'user' | 'assistant'; content: string; payload: AssistantPayload | null }[] };
      setThreadId(id);
      if (title) setThreadTitle(title);
      else {
        const firstQ = j.messages.find((m) => m.role === 'user');
        if (firstQ) setThreadTitle(firstQ.content.replace(/[?".]/g, '').split(/\s+/).slice(0, 5).join(' '));
      }
      setMessages(j.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, payload: m.payload })));
      liveRef.current = null;
      setLive(null);
      scrollDown();
      return true;
    } catch {
      return false;
    }
  }, [projectId, scrollDown]);

  // Deep link (?thread=) — load once when the project is known.
  useEffect(() => {
    if (!projectId || !opts?.initialThreadId || initialLoadedRef.current) return;
    initialLoadedRef.current = true;
    void openThreadById(opts.initialThreadId);
  }, [projectId, opts?.initialThreadId, openThreadById]);

  const updateLive = useCallback((patch: Partial<LiveRun>) => {
    liveRef.current = { ...(liveRef.current as LiveRun), ...patch };
    setLive(liveRef.current);
  }, []);

  const ask = useCallback(async (question: string) => {
    if (!projectId || abortRef.current) return; // one in-flight run per surface
    const q = question.trim();
    if (!q) return;
    setMessages((ms) => [...ms, { id: `u-${Date.now()}`, role: 'user', content: q, payload: null }]);
    if (!threadTitle) setThreadTitle(q.replace(/[?".]/g, '').split(/\s+/).slice(0, 5).join(' '));
    const run: LiveRun = { statusLabel: 'Reading the question…', footprints: [], blocks: [], text: '', composing: false, interrupted: false, error: null, question: q };
    liveRef.current = run;
    setLive(run);
    scrollDown();

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/admin/projects/${projectId}/researcher`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, threadId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`request failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev: ResearcherEvent;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'meta') {
            setThreadId(ev.threadId);
            setThreadTitle(ev.title);
          } else if (ev.type === 'queued') {
            updateLive({ statusLabel: `Queued — ${ev.position === 1 ? 'next up' : `${ev.position} ahead in line`}…` });
          } else if (ev.type === 'tool') {
            if (ev.status === 'start') updateLive({ statusLabel: `${ev.label}…` });
            else {
              const cur = liveRef.current!;
              updateLive({
                footprints: [...cur.footprints, { name: ev.name, label: ev.status === 'error' ? `${ev.label} (failed)` : ev.label, ms: ev.ms ?? 0 }],
                statusLabel: cur.statusLabel,
              });
            }
          } else if (ev.type === 'block') {
            updateLive({ blocks: [...liveRef.current!.blocks, ev.block] });
            scrollDown();
          } else if (ev.type === 'token') {
            updateLive({ statusLabel: null, composing: true, text: liveRef.current!.text + ev.text });
            scrollDown();
          } else if (ev.type === 'done') {
            setMessages((ms) => [...ms, { id: ev.messageId, role: 'assistant', content: ev.content, payload: ev.payload }]);
            liveRef.current = null;
            setLive(null);
            scrollDown();
          } else if (ev.type === 'busy') {
            updateLive({ statusLabel: null, error: ev.message });
          } else if (ev.type === 'error') {
            updateLive({ statusLabel: null, error: ev.message });
          }
        }
      }
      // Stream closed without done (e.g. server abort): keep the partial.
      if (liveRef.current && !liveRef.current.error) {
        finalizePartial();
      }
    } catch {
      if (ctrl.signal.aborted) {
        finalizePartial();
      } else if (liveRef.current) {
        updateLive({ statusLabel: null, error: 'Connection lost mid-research — ask again and I will retry.' });
      }
    } finally {
      abortRef.current = null;
    }

    function finalizePartial() {
      const cur = liveRef.current;
      if (!cur) return;
      if (cur.text || cur.blocks.length > 0) {
        setMessages((ms) => [...ms, {
          id: `p-${Date.now()}`, role: 'assistant', content: cur.text,
          payload: { blocks: cur.blocks, citations: [], caveat: null, followups: [], footprints: cur.footprints, interrupted: true },
        }]);
        liveRef.current = null;
        setLive(null);
      } else {
        // Nothing landed (e.g. the server restarted mid-stream) — a
        // silent vanish is a dead end; surface it with a retry.
        updateLive({ statusLabel: null, error: 'The connection dropped before I could answer — try again.' });
      }
    }
  }, [projectId, threadId, threadTitle, scrollDown, updateLive]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const newThread = useCallback(() => {
    stop();
    setThreadId(null); setThreadTitle(null); setMessages([]);
    liveRef.current = null; setLive(null);
  }, [stop]);

  const retryLive = useCallback(() => {
    const q = liveRef.current?.question;
    liveRef.current = null;
    setLive(null);
    if (q) void ask(q);
  }, [ask]);

  const retryLast = useCallback(() => {
    const lastQ = [...messages].reverse().find((x) => x.role === 'user');
    if (lastQ) void ask(lastQ.content);
  }, [messages, ask]);

  const busy = live !== null && !live.error;

  return {
    threadId, threadTitle, messages, live, busy,
    observations, threads,
    scrollRef,
    ask, stop, newThread, retryLive, retryLast,
    loadObservations, loadThreads, openThreadById,
  };
}

export type ResearcherChat = ReturnType<typeof useResearcherChat>;
