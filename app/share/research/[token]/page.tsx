// Public, read-only view of a shared Researcher thread. No auth — the
// token itself is the capability. Lives outside every route group so
// it never picks up admin or workspace chrome.
import { notFound } from 'next/navigation';
import { threadByShareToken } from '@/lib/researcher/threads';
import { ShareConversation } from '@/components/researcher/share-conversation';
import styles from '@/components/researcher/researcher.module.css';

export default async function SharedResearchPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const thread = await threadByShareToken(token);
  if (!thread) notFound();

  const latest = thread.messages[thread.messages.length - 1]?.createdAt;

  return (
    <div className={styles.ws}>
      {/* .wsMain spans the full viewport width (as it does in the real
          workspace) — the actual overflow-y:auto element is inside it, so
          the native scrollbar lands at the true browser edge. Content
          centers itself independently (this header block + the
          conversation's own max-width), never the scroll container. */}
      <main className={styles.wsMain}>
        <div className={styles.wsHead}>
          <span className={styles.wsWordmark}>PocketScience<small>Researcher · shared read-only</small></span>
        </div>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '4px 32px 0', width: '100%' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>{thread.title}</h1>
          {latest && (
            <p style={{ fontSize: 12.5, color: 'var(--muted-foreground)', margin: '2px 0 0' }}>
              {new Date(latest).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <ShareConversation projectId={thread.projectId} messages={thread.messages} />
      </main>
    </div>
  );
}
