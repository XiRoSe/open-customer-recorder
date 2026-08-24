'use client';

// The full-screen research workspace (per the locked mock): a
// collapsible history rail (closed by default), a branded header with
// share + minimize, and the shared conversation at full width. Same
// chat core as the drawer — only the shell differs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ThreadSummary } from '@/lib/researcher/types';
import { SurfaceContext } from './surface';
import { useResearcherChat } from './use-researcher-chat';
import { Conversation } from './conversation';
import { AskInput } from './ask-input';
import { ThreadList } from './thread-list';
import styles from './researcher.module.css';

const SECTIONS = new Set(['overview', 'sessions', 'timeline', 'users', 'clusters', 'tags', 'settings']);

export function ResearcherWorkspace({ projectId, name, initialThreadId, from }: {
  projectId: string;
  name: string;
  initialThreadId: string | null;
  from: string | null;
}) {
  const router = useRouter();
  const chat = useResearcherChat(projectId, { initialThreadId });
  const [railOpen, setRailOpen] = useState(false);
  // The rail overlays (rather than squeezing) content below 700px — see
  // the CSS breakpoint. There, picking a thread should close it, same
  // as any mobile drawer; on wider screens it stays pinned open.
  const closeRailOnNarrow = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 700) setRailOpen(false);
  }, []);
  const [shareState, setShareState] = useState<'idle' | 'working' | 'copied'>('idle');

  const { loadObservations, loadThreads } = chat;
  useEffect(() => { loadObservations(); }, [loadObservations]);
  useEffect(() => { loadThreads(); }, [loadThreads]);
  // Keep the rail fresh as answers land (titles + ordering shift).
  const answerCount = chat.messages.filter((m) => m.role === 'assistant').length;
  useEffect(() => { if (answerCount > 0) loadThreads(); }, [answerCount, loadThreads]);

  const minimize = useCallback(() => {
    const section = from && SECTIONS.has(from) ? from : 'overview';
    router.push(`/projects/${projectId}/${section}`);
  }, [router, projectId, from]);

  const share = useCallback(async () => {
    if (!chat.threadId || shareState === 'working') return;
    setShareState('working');
    try {
      const res = await fetch(`/api/admin/projects/${projectId}/researcher/threads/${chat.threadId}/share`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.url) throw new Error(j.error || 'share failed');
      await navigator.clipboard?.writeText(new URL(j.url, window.location.origin).toString()).catch(() => {});
      setShareState('copied');
      setTimeout(() => setShareState('idle'), 2500);
    } catch {
      setShareState('idle');
    }
  }, [chat.threadId, projectId, shareState]);

  // The active thread appears in the rail even before the list refresh
  // catches up (live rename on the first question).
  const railThreads: ThreadSummary[] | null = useMemo(() => {
    if (chat.threads === null) return null;
    const live: ThreadSummary[] = [];
    if (chat.threadTitle && !chat.threads.some((t) => t.id === chat.threadId)) {
      live.push({ id: chat.threadId ?? 'live', title: chat.threadTitle, lastMessageAt: new Date().toISOString(), finding: null });
    }
    return [...live, ...chat.threads];
  }, [chat.threads, chat.threadId, chat.threadTitle]);

  return (
    <SurfaceContext.Provider value="workspace">
      <div className={styles.ws}>
        {/* Narrow screens only (CSS-gated) — tap outside the overlaid
            rail to close it, same as any mobile drawer. */}
        {railOpen && <div className={styles.wsScrim} onClick={() => setRailOpen(false)} />}
        <aside className={`${styles.wsRail} ${railOpen ? '' : styles.wsRailHidden}`} aria-label="Research history">
          <div className={styles.wsRailInner}>
            <div className={styles.wsRailTop}>
              <div className={styles.wsBrandRow}>
                <span className={styles.wsGlyph}>R</span>
                <span><span className={styles.wsBrandT}>Researcher</span><span className={styles.wsBrandS}>research workspace</span></span>
              </div>
              <button type="button" className={styles.wsNew} onClick={() => { chat.newThread(); closeRailOnNarrow(); }}>
                <span className={styles.wsPlus}>+</span> New research
              </button>
            </div>
            <div className={styles.wsRailList}>
              <ThreadList
                threads={railThreads}
                activeId={chat.threadId}
                onPick={(t) => { if (t.id !== chat.threadId) void chat.openThreadById(t.id, t.title); closeRailOnNarrow(); }}
              />
            </div>
          </div>
        </aside>

        <main className={styles.wsMain}>
          <div className={styles.wsHead}>
            <button type="button" className={styles.iconBtn} title={railOpen ? 'Hide research history' : 'Show research history'} onClick={() => setRailOpen(!railOpen)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" />
                {railOpen ? <path d="M16 9l-3 3 3 3" /> : <path d="M13 9l3 3-3 3" />}
              </svg>
            </button>
            <span className={styles.wsWordmark} style={{ marginLeft: 6 }}>MEGA RECORDER<small>Researcher</small></span>
            <div className={styles.wsActions}>
              {shareState === 'copied' && <span className={styles.wsShared}>Link copied ✓</span>}
              <button
                type="button"
                className={styles.iconBtn}
                title={chat.threadId ? 'Share a read-only link to this research session' : 'Ask something first, then share the session'}
                onClick={share}
                disabled={!chat.threadId || shareState === 'working'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 10.7l6.8-4.4M8.6 13.3l6.8 4.4" /></svg>
              </button>
              <button type="button" className={styles.iconBtn} title="Minimize — back to the dashboard" onClick={minimize}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              </button>
            </div>
          </div>

          <div className={styles.wsThread} ref={chat.scrollRef}>
            <div className={styles.wsThreadInner}>
              <Conversation chat={chat} projectId={projectId} name={name} />
            </div>
          </div>

          <div className={styles.wsInput}>
            <AskInput chat={chat} />
          </div>
        </main>
      </div>
    </SurfaceContext.Provider>
  );
}
