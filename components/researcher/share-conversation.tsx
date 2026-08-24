'use client';

// Read-only rendering of a shared research thread — same Conversation
// component as the drawer/workspace, fed a static (non-live) chat
// object instead of the SSE-backed hook. No auth, no input, no
// follow-up actions; the rich boxes (real TimelineChart/ClusterMap)
// still render exactly as they do in the workspace.
import { useRef } from 'react';
import type { ThreadMessage } from '@/lib/researcher/types';
import { SurfaceContext } from './surface';
import { Conversation } from './conversation';
import type { ChatMessage, ResearcherChat } from './use-researcher-chat';
import styles from './researcher.module.css';

export function ShareConversation({ projectId, messages }: { projectId: string; messages: ThreadMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatMessages: ChatMessage[] = messages.map((m) => ({ id: m.id, role: m.role, content: m.content, payload: m.payload }));

  const staticChat: ResearcherChat = {
    threadId: null,
    threadTitle: null,
    messages: chatMessages,
    live: null,
    busy: false,
    observations: null,
    threads: null,
    scrollRef,
    ask: async () => {},
    stop: () => {},
    newThread: () => {},
    retryLive: () => {},
    retryLast: () => {},
    loadObservations: () => {},
    loadThreads: () => {},
    openThreadById: async () => false,
  };

  return (
    <SurfaceContext.Provider value="share">
      <div className={styles.wsThread} ref={scrollRef}>
        <div className={styles.wsThreadInner}>
          <Conversation chat={staticChat} projectId={projectId} name="" readOnly />
        </div>
      </div>
    </SurfaceContext.Provider>
  );
}
