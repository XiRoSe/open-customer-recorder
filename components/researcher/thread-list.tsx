'use client';

// The research history list, grouped Today / Yesterday / Earlier.
// Shared by the drawer's History view and the workspace's rail — same
// items, the surface CSS scope handles the rest.
import type { ThreadSummary } from '@/lib/researcher/types';
import styles from './researcher.module.css';

function groupOf(iso: string): 'Today' | 'Yesterday' | 'Earlier' {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return 'Today';
  const y = new Date(now.getTime() - 86_400_000);
  if (day(d) === day(y)) return 'Yesterday';
  return 'Earlier';
}

export function ThreadList({ threads, activeId, onPick, emptyText }: {
  threads: ThreadSummary[] | null;
  activeId: string | null;
  onPick: (t: ThreadSummary) => void;
  emptyText?: string;
}) {
  if (threads === null) return <div className={styles.hEmpty}>Loading…</div>;
  if (threads.length === 0) {
    return <div className={styles.hEmpty}>{emptyText ?? 'Nothing yet — ask your first question and it lands here.'}</div>;
  }
  const groups: ['Today' | 'Yesterday' | 'Earlier', ThreadSummary[]][] = [['Today', []], ['Yesterday', []], ['Earlier', []]];
  for (const t of threads) groups.find(([g]) => g === groupOf(t.lastMessageAt))![1].push(t);
  return (
    <>
      {groups.filter(([, items]) => items.length > 0).map(([label, items]) => (
        <div key={label}>
          <div className={styles.railGroup}>{label}</div>
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.hItem} ${t.id === activeId ? styles.hItemActive : ''}`}
              onClick={() => onPick(t)}
            >
              <b>{t.title}</b>
              <small>{t.finding ? t.finding.slice(0, 70) : new Date(t.lastMessageAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</small>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
