'use client';

// The Researcher drawer — a thin shell over the shared chat core
// (use-researcher-chat + Conversation + AskInput + ThreadList). Entry
// is the brass "R" edge card; the ⛶ at the header's left expands into
// the full-screen research workspace carrying the current thread.
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { SurfaceContext } from './surface';
import { useResearcherChat } from './use-researcher-chat';
import { Conversation } from './conversation';
import { AskInput } from './ask-input';
import { ThreadList } from './thread-list';
import styles from './researcher.module.css';

export function Researcher({ name, email }: { name: string; email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const m = pathname?.match(/^\/projects\/([^/]+)\/(overview|sessions|timeline|users|clusters|tags|settings)/);
  const projectId = m?.[1] ?? null;
  const section = m?.[2] ?? 'overview';

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const chat = useResearcherChat(projectId);

  // Greeting observations load on first open; project switch resets view.
  const { loadObservations, loadThreads } = chat;
  useEffect(() => { if (open) loadObservations(); }, [open, loadObservations]);
  useEffect(() => { setView('chat'); }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toggleHistory = useCallback(() => {
    if (view === 'history') { setView('chat'); return; }
    setView('history');
    loadThreads();
  }, [view, loadThreads]);

  const expand = useCallback(() => {
    if (!projectId) return;
    const p = new URLSearchParams({ from: section });
    if (chat.threadId) p.set('thread', chat.threadId);
    router.push(`/projects/${projectId}/researcher?${p}`);
  }, [projectId, section, chat.threadId, router]);

  if (!projectId) return null;

  const showContinuing = view === 'chat' && chat.threadTitle !== null && chat.messages.length > 0;

  return (
    <SurfaceContext.Provider value="drawer">
      {!open && (
        <div className={styles.edgeCard} onClick={() => setOpen(true)} role="button" aria-label="Open the Researcher">
          <span className={styles.glyph}>R</span>
          <span><small>Query your data</small></span>
        </div>
      )}
      <aside className={`${styles.drawer} ${open ? styles.drawerOpen : ''}`} aria-label="Researcher">
        <div className={styles.drawerInner}>
        <div className={styles.dHead}>
          <div className={styles.dRow}>
            <span className={styles.dTitle}>Researcher</span>
            <button type="button" className={styles.iconBtn} title="Open the full research workspace" onClick={expand}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7" /></svg>
            </button>
            <button type="button" className={styles.iconBtn} title="History" onClick={toggleHistory}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 3" /></svg>
            </button>
            <button type="button" className={styles.iconBtn} title="New thread" onClick={() => { chat.newThread(); setView('chat'); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" className={styles.iconBtn} title="Close" onClick={() => setOpen(false)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className={styles.hline}><div className={styles.hlineA} /><div className={styles.hlineB} /></div>
          {showContinuing && (
            <div className={styles.continuing}>
              <span className={styles.cLabel}>Continuing · <span>{chat.threadTitle}</span></span>
            </div>
          )}
        </div>

        {view === 'history' ? (
          <div className={styles.history}>
            <div className={styles.hUser}>Your research · {email}</div>
            <ThreadList
              threads={chat.threads}
              activeId={chat.threadId}
              onPick={(t) => { void chat.openThreadById(t.id, t.title); setView('chat'); }}
            />
          </div>
        ) : (
          <>
            <div className={styles.thread} ref={chat.scrollRef}>
              <Conversation chat={chat} projectId={projectId} name={name} />
            </div>
            <div className={styles.dInput}>
              <AskInput chat={chat} />
            </div>
          </>
        )}
        </div>
      </aside>
    </SurfaceContext.Provider>
  );
}
