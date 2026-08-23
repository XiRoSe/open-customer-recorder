'use client';

// The Researcher: a read-only AI analyst in a right-side drawer.
// Entry is the brass "R" edge card; answers stream over SSE with live
// footprints, a brass provenance thread, typed evidence blocks, and
// grounded follow-ups. Threads persist per admin; History replaces the
// chat view entirely (per the approved mock).
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { AssistantPayload, Footprint, ResearcherBlock, ResearcherEvent, ThreadSummary } from '@/lib/researcher/types';
import { BlockView, CitationChips } from './blocks';
import styles from './researcher.module.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload: AssistantPayload | null;
}

interface LiveRun {
  statusLabel: string | null;
  footprints: Footprint[];
  blocks: ResearcherBlock[];
  text: string;
  composing: boolean;
  interrupted: boolean;
  error: string | null;
  question: string;
}

interface Observation { text: string; strong: string; question: string }

function greetingWord(): string {
  const h = new Date().getHours();
  // 0–5 counts as evening — "Morning" at 1am reads wrong.
  return h < 6 ? 'Evening' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

export function Researcher({ name, email }: { name: string; email: string }) {
  const pathname = usePathname();
  const m = pathname?.match(/^\/projects\/([^/]+)\/(overview|sessions|timeline|users|clusters|tags|settings)/);
  const projectId = m?.[1] ?? null;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LiveRun | null>(null);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Greeting observations, fetched once per project on first open.
  useEffect(() => {
    if (!open || !projectId || observations !== null) return;
    fetch(`/api/admin/projects/${projectId}/researcher/observations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setObservations(j?.observations ?? []))
      .catch(() => setObservations([]));
  }, [open, projectId, observations]);

  // Project switch resets the conversation (threads are per-project).
  useEffect(() => {
    setThreadId(null); setThreadTitle(null); setMessages([]); setLive(null);
    setObservations(null); setThreads(null); setView('chat');
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const updateLive = useCallback((patch: Partial<LiveRun>) => {
    liveRef.current = { ...(liveRef.current as LiveRun), ...patch };
    setLive(liveRef.current);
  }, []);

  const ask = useCallback(async (question: string) => {
    if (!projectId || abortRef.current) return; // one in-flight run per drawer
    const q = question.trim();
    if (!q) return;
    setView('chat');
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
  const busy = live !== null && !live.error;

  const newThread = useCallback(() => {
    stop();
    setThreadId(null); setThreadTitle(null); setMessages([]); setLive(null); setView('chat');
  }, [stop]);

  const toggleHistory = useCallback(() => {
    if (view === 'history') { setView('chat'); return; }
    setView('history');
    if (projectId) {
      fetch(`/api/admin/projects/${projectId}/researcher/threads`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setThreads(j?.threads ?? []))
        .catch(() => setThreads([]));
    }
  }, [view, projectId]);

  const openThread = useCallback(async (t: ThreadSummary) => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/admin/projects/${projectId}/researcher/threads/${t.id}`);
      if (!res.ok) return;
      const j = await res.json() as { messages: { id: string; role: 'user' | 'assistant'; content: string; payload: AssistantPayload | null }[] };
      setThreadId(t.id);
      setThreadTitle(t.title);
      setMessages(j.messages.map((m2) => ({ id: m2.id, role: m2.role, content: m2.content, payload: m2.payload })));
      setLive(null);
      setView('chat');
      scrollDown();
    } catch { /* stay on history */ }
  }, [projectId, scrollDown]);

  if (!projectId) return null;

  const showGreeting = messages.length === 0 && live === null;
  const showContinuing = view === 'chat' && threadTitle !== null && messages.length > 0;

  return (
    <>
      {!open && (
        <div className={styles.edgeCard} onClick={() => setOpen(true)} role="button" aria-label="Open the Researcher">
          <span className={styles.glyph}>R</span>
          <span><small>Query your data</small></span>
        </div>
      )}
      <div className={`${styles.scrim} ${open ? styles.scrimOpen : ''}`} onClick={() => setOpen(false)} />
      <aside className={`${styles.drawer} ${open ? styles.drawerOpen : ''}`} aria-label="Researcher">
        <div className={styles.dHead}>
          <div className={styles.dRow}>
            <span className={styles.dTitle}>Researcher</span>
            <button type="button" className={styles.iconBtn} title="History" onClick={toggleHistory}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 3" /></svg>
            </button>
            <button type="button" className={styles.iconBtn} title="New thread" onClick={newThread}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" className={styles.iconBtn} title="Close" onClick={() => setOpen(false)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className={styles.hline}><div className={styles.hlineA} /><div className={styles.hlineB} /></div>
          {showContinuing && (
            <div className={styles.continuing}>
              <span className={styles.cLabel}>Continuing · <span>{threadTitle}</span></span>
              <button type="button" className={styles.cNew} onClick={newThread}>New thread</button>
            </div>
          )}
        </div>

        {view === 'history' ? (
          <div className={styles.history}>
            <div className={styles.hUser}>Your research · {email}</div>
            {threads === null && <div className={styles.hEmpty}>Loading…</div>}
            {threads !== null && threads.length === 0 && <div className={styles.hEmpty}>Nothing yet — ask your first question and it lands here.</div>}
            {threads?.map((t) => (
              <button key={t.id} type="button" className={styles.hItem} onClick={() => openThread(t)}>
                <b>{t.title}</b>
                <small>{new Date(t.lastMessageAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}{t.finding ? ` · ${t.finding.slice(0, 70)}` : ''}</small>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className={styles.thread} ref={threadRef}>
              {showGreeting && (
                <div className={styles.hello}>
                  <h2>{greetingWord()}, {name}.</h2>
                  <div className={styles.helloP}>I read your sessions, visitors, timelines and clusters — and never change a thing.</div>
                  {observations && observations.length > 0 && (
                    <>
                      <div className={styles.noticed}>While you were away I noticed</div>
                      <div className={styles.obs}>
                        {observations.map((o, i) => (
                          <button key={i} type="button" className={styles.obsBtn} onClick={() => ask(o.question)}>
                            {o.text.includes('{strong}')
                              ? <>{o.text.split('{strong}')[0]}<b>{o.strong}</b>{o.text.split('{strong}')[1]}</>
                              : <><b>{o.strong}</b> — {o.text}</>}
                            <span className={styles.askHint}>Ask about this →</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div className={styles.wayfind}>Ask about sessions, visitors, timelines, clusters, or tags.</div>
                </div>
              )}

              {messages.map((msg) => msg.role === 'user'
                ? <div key={msg.id} className={styles.msgUser}>{msg.content}</div>
                : <AssistantMessage key={msg.id} content={msg.content} payload={msg.payload} projectId={projectId} threadId={threadId} onAsk={ask} onRetry={() => {
                    const lastQ = [...messages].reverse().find((x) => x.role === 'user');
                    if (lastQ) ask(lastQ.content);
                  }} />)}

              {live && (
                <div className={styles.msgAi}>
                  <span className={styles.threadLine}>
                    <i className={styles.threadLineFill} style={{ height: live.composing || live.error ? '100%' : `${Math.min(90, (live.footprints.length + 1) * 28)}%` }} />
                  </span>
                  <div>
                    {live.statusLabel && (
                      <div className={styles.status}><i className={styles.statusDot} /><span>{live.statusLabel}</span></div>
                    )}
                    {live.composing && live.footprints.length > 0 && <FootprintsView footprints={live.footprints} />}
                    {live.text && <div className={`${styles.prose} ${styles.caret}`}>{live.text}</div>}
                    {live.blocks.map((b, i) => <BlockView key={i} block={b} projectId={projectId} threadId={threadId} />)}
                    {live.error && (
                      <div className={styles.busyNote}>
                        {live.error}
                        <div className={styles.stopped}>
                          <button type="button" onClick={() => { const q = live.question; liveRef.current = null; setLive(null); ask(q); }}>Try again</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className={styles.dInput}>
              <div className={styles.inRow}>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Query your data…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy && input.trim()) { ask(input); setInput(''); }
                  }}
                />
                <button
                  type="button"
                  className={`${styles.askBtn} ${busy ? styles.askStop : ''}`}
                  onClick={() => {
                    if (busy) stop();
                    else if (input.trim()) { ask(input); setInput(''); }
                  }}
                >
                  {busy ? '◼' : 'Ask'}
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function FootprintsView({ footprints }: { footprints: Footprint[] }) {
  const [openF, setOpenF] = useState(false);
  const total = (footprints.reduce((s, f) => s + f.ms, 0) / 1000).toFixed(1);
  return (
    <div>
      <button type="button" className={styles.footprints} onClick={() => setOpenF(!openF)}>
        Researched · {footprints.length} step{footprints.length === 1 ? '' : 's'} · {total}s
        <span className={`${styles.chev} ${openF ? styles.chevOpen : ''}`}>▼</span>
      </button>
      {openF && (
        <div className={styles.fpList}>
          {footprints.map((f, i) => (
            <div key={i} className={styles.fpStep}>
              {f.label}
              <span className={styles.fpDur}>{(f.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ content, payload, projectId, threadId, onAsk, onRetry }: {
  content: string;
  payload: AssistantPayload | null;
  projectId: string;
  threadId: string | null;
  onAsk: (q: string) => void;
  onRetry: () => void;
}) {
  const p = payload;
  return (
    <div className={styles.msgAi}>
      <span className={styles.threadLine}><i className={styles.threadLineFill} style={{ height: '100%' }} /></span>
      <div>
        {p && p.footprints.length > 0 && <FootprintsView footprints={p.footprints.filter((f) => f.name !== 'compose')} />}
        {content && <div className={styles.prose}>{content}</div>}
        {p?.blocks.map((b, i) => <BlockView key={i} block={b} projectId={projectId} threadId={threadId} />)}
        {p?.caveat && <div className={styles.caveat}>{p.caveat}</div>}
        {p && <CitationChips citations={p.citations} />}
        {p?.interrupted && (
          <div className={styles.stopped}>
            Response interrupted
            <button type="button" onClick={onRetry}>Ask again</button>
          </div>
        )}
        {p && p.followups.length > 0 && (
          <div className={styles.followups}>
            {p.followups.map((f) => (
              <button key={f} type="button" className={styles.fuBtn} onClick={() => onAsk(f)}>
                <span className={styles.qdot} />{f}
              </button>
            ))}
          </div>
        )}
        {p && !p.interrupted && (
          <div className={styles.actions}>
            <button type="button" onClick={onRetry}>Retry</button>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(content).catch(() => {}); }}>Copy</button>
          </div>
        )}
      </div>
    </div>
  );
}
