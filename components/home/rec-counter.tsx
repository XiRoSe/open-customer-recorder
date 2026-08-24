'use client';
import { useEffect, useState } from 'react';
import styles from '@/app/home.module.css';

function format(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** A ticking REC readout — a small, honest wink at what the product
 * actually does (record), not a fake stat. Counts from page load. */
export function RecCounter() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <p className={`${styles.recLine} ${styles.mono}`}>
      <span className={styles.recDot} aria-hidden />
      REC {format(seconds)}
    </p>
  );
}
