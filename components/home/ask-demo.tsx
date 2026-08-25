'use client';
import { useEffect, useState } from 'react';
import styles from '@/app/home.module.css';

interface QA { q: string; a: string; steps: string; }

const QAS: QA[] = [
  {
    q: 'Why do people quit checkout on mobile?',
    a: 'The coupon field - the keyboard hides your Pay button.',
    steps: 'CHECKED 214 SESSIONS · 11s',
  },
  {
    q: 'What did yesterday’s launch traffic do?',
    a: 'Read pricing twice, skipped the FAQ. Two signed up.',
    steps: 'CHECKED 168 SESSIONS · 14s',
  },
  {
    q: 'Who’s our most frustrated visitor?',
    a: 'A Safari user - four rage clicks on a dead Save button.',
    steps: 'CHECKED 309 SESSIONS · 9s',
  },
];

/**
 * The hero: questions type themselves into the pill, the answer streams
 * back short and sharp, then the receipts appear — the footprint line
 * and the "watch that session" citation, exactly the anatomy of a real
 * answer in the product. Deterministic loop; reduced motion shows the
 * first Q&A fully rendered, static.
 */
export function AskDemo() {
  const [qi, setQi] = useState(0);
  const [qLen, setQLen] = useState(0);
  const [aWords, setAWords] = useState(0);
  const [showMeta, setShowMeta] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setQLen(QAS[0].q.length);
      setAWords(QAS[0].a.split(' ').length);
      setShowMeta(true);
      return;
    }
    let alive = true;
    let idx = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (;;) {
        const qa = QAS[idx];
        setQi(idx);
        setQLen(0);
        setAWords(0);
        setShowMeta(false);
        await sleep(650);
        for (let i = 1; i <= qa.q.length; i++) {
          if (!alive) return;
          setQLen(i);
          await sleep(38);
        }
        await sleep(600);
        const words = qa.a.split(' ');
        for (let i = 1; i <= words.length; i++) {
          if (!alive) return;
          setAWords(i);
          await sleep(80);
        }
        setShowMeta(true);
        await sleep(4200);
        if (!alive) return;
        idx = (idx + 1) % QAS.length;
      }
    })();
    return () => { alive = false; };
  }, []);

  const qa = QAS[qi];
  const words = qa.a.split(' ');
  const answering = aWords > 0 && aWords < words.length;

  return (
    <div className={styles.ask} aria-hidden>
      <div className={styles.askInput}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <circle cx="10.5" cy="10.5" r="6" />
          <line x1="15" y1="15" x2="20" y2="20" />
        </svg>
        <span className={styles.askQ}>{qa.q.slice(0, qLen)}</span>
        <span className={styles.askCaret} data-active={qLen < qa.q.length ? '1' : undefined} />
      </div>
      <div className={styles.askAnswer}>
        <p className={styles.askA}>
          {words.slice(0, aWords).join(' ')}
          {answering && <span className={styles.askCaret} data-active="1" />}
        </p>
        <div className={styles.askMeta} data-shown={showMeta ? '1' : undefined}>
          <span className={`${styles.askSteps} ${styles.mono}`}>{qa.steps}</span>
          <span className={styles.askChip}>Watch that session ↗</span>
        </div>
      </div>
    </div>
  );
}
