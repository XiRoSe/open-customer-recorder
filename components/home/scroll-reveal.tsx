'use client';
import { useEffect } from 'react';
import styles from '@/app/home.module.css';

/** Progressive enhancement only: marks the page JS-ready (CSS in
 * home.module.css keeps [data-reveal] elements fully visible until this
 * class lands, so a slow/failed script never hides content) and fades
 * each [data-reveal] block in the first time it crosses the viewport. */
export function ScrollReveal() {
  useEffect(() => {
    document.documentElement.classList.add(styles.jsReady);
    const els = Array.from(document.querySelectorAll('[data-reveal]'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add(styles.isVisible));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.isVisible);
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}
