import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollReveal } from '@/components/home/scroll-reveal';
import { AskDemo } from '@/components/home/ask-demo';
import styles from './home.module.css';

const BRAND = 'PocketScience';
const OSS_URL = 'https://github.com/XiRoSe/pocketscience-oss';

const TAPE = [
  'Replay every visit',
  'Plain-English answers',
  'Rage-click detection',
  'Session narratives',
  'Visitor clusters',
  'Auto-tags',
  'Open source',
];

export const metadata: Metadata = {
  title: BRAND,
  description: 'Ask your website anything. Session replay + an AI researcher, in the cloud or on your own server.',
};

export default function Home() {
  return (
    <div className={styles.page}>
      <ScrollReveal />

      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.topRow}>
            <span className={styles.wordmark}>{BRAND}</span>
            <Link href="/login" className={styles.loginBtn}>
              Log in <span aria-hidden>&rarr;</span>
            </Link>
          </div>

          <div className={styles.heroCenter}>
            <p className={styles.eyebrow}>Your whole user-research lab. Pocket-sized.</p>
            <h1 className={styles.headline}>
              <span className={styles.headlineLine}><span>Ask your website</span></span>
              <span className={styles.headlineLine}><span className={styles.headlineBrass}>anything.</span></span>
            </h1>

            <AskDemo />

            <div className={styles.heroCtas}>
              <Link href="/login" className={styles.ctaPrimary}>
                Open the lab <span aria-hidden>&rarr;</span>
              </Link>
              <p className={`${styles.ctaNote} ${styles.mono}`}>Cloud or self-hosted · open source</p>
            </div>
          </div>
        </div>

        <div className={styles.tape} aria-hidden>
          <div className={styles.tapeInner}>
            {[...TAPE, ...TAPE].map((item, i) => (
              <span key={i} className={styles.tapeItem}>{item}<span className={styles.tapeDot}>·</span></span>
            ))}
          </div>
        </div>
      </header>

      <section className={styles.choiceBand} data-reveal>
        <div className={styles.choiceInner}>
          <p className={styles.eyebrow}>Run it your way</p>
          <h2 className={styles.h2}>Cloud, or self-hosted.</h2>
          <p className={styles.bandSub}>Same lab, two ways to plug it in.</p>
          <div className={styles.choice}>
            <div className={styles.choiceCard}>
              <span className={`${styles.choiceLabel} ${styles.mono}`}>Cloud</span>
              <h3>We host it</h3>
              <p>Sign up, paste one script tag, watch your first session come in minutes later.</p>
              <Link href="/login" className={styles.ctaPrimary}>
                Start now <span aria-hidden>&rarr;</span>
              </Link>
            </div>
            <div className={styles.choiceCard}>
              <span className={`${styles.choiceLabel} ${styles.mono}`}>Self-hosted</span>
              <h3>You host it</h3>
              <p>One Docker container on your own server. Sessions never leave your infrastructure.</p>
              <a href={OSS_URL} className={styles.ctaGhost} target="_blank" rel="noopener noreferrer">
                Get the code <span aria-hidden>↗</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.closing} data-reveal>
        <div className={styles.closingInner}>
          <div>
            <p className={styles.closingClaim}>
              Big-lab research. One small server. Yours.
            </p>
            <p className={`${styles.mono} ${styles.eyebrow}`} style={{ marginTop: '0.75rem' }}>
              Sessions never leave your hands
            </p>
          </div>
          <Link href="/login" className={styles.ctaPrimary}>
            Open the lab <span aria-hidden>&rarr;</span>
          </Link>
        </div>
        <div className={styles.footer}>
          <span className={styles.mono}>{BRAND}</span>
          <Link href="/login">Log in</Link>
        </div>
      </section>
    </div>
  );
}
