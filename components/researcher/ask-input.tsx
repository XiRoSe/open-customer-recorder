'use client';

// The ask pill — shared by the drawer and the workspace. Ask morphs to
// stop while a run streams.
import { useState } from 'react';
import type { ResearcherChat } from './use-researcher-chat';
import styles from './researcher.module.css';

export function AskInput({ chat }: { chat: ResearcherChat }) {
  const [input, setInput] = useState('');
  const { busy } = chat;
  const submit = () => {
    if (busy || !input.trim()) return;
    chat.ask(input);
    setInput('');
  };
  return (
    <div className={styles.inRow}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Query your data…"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button
        type="button"
        className={`${styles.askBtn} ${busy ? styles.askStop : ''}`}
        onClick={() => { if (busy) chat.stop(); else submit(); }}
      >
        {busy ? '◼' : 'Ask'}
      </button>
    </div>
  );
}
