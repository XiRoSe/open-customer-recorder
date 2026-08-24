import type { Metadata } from 'next';
import Link from 'next/link';
import { RecCounter } from '@/components/home/rec-counter';
import { ScrollReveal } from '@/components/home/scroll-reveal';
import styles from './home.module.css';

const BRAND = 'OPEN CUSTOMER RECORDER';

export const metadata: Metadata = {
  title: BRAND,
  description: 'Self-hosted session replay with an AI that has already watched every visit.',
};

const STRIP_HEIGHTS = [22, 38, 18, 55, 30, 70, 26, 44, 60, 20, 48, 34, 66, 24, 40, 52, 28, 62, 18, 46, 36, 58, 20, 42];

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

          <p className={styles.eyebrow}>Session replay + AI research</p>
          <span className={styles.rule} aria-hidden />
          <h1 className={styles.headline}>
            <span className={styles.headlineLine}><span>Every visit,</span></span>
            <span className={styles.headlineLine}><span>on the record.</span></span>
          </h1>

          <div className={styles.heroBody}>
            <p className={styles.subline}>
              Watch exactly what a visitor did — every click, rage-click, and dead end —
              then ask an AI that has already read the whole session what it means.
              Self-hosted, so the recordings never leave your infrastructure.
            </p>
            <RecCounter />
          </div>
        </div>

        <div className={styles.strip} aria-hidden>
          <span className={styles.playhead} />
          {STRIP_HEIGHTS.map((h, i) => (
            <span key={i} className={styles.stripBar} data-hi={i % 6 === 3 ? '1' : undefined} style={{ height: `${h}%` }} />
          ))}
        </div>
      </header>

      <section className={styles.band} data-reveal>
        <div className={styles.bandInner}>
          <div className={styles.bandText}>
            <p className={styles.eyebrow}>Sessions</p>
            <h2>Pixel-accurate replay, not a heatmap guess.</h2>
            <p>
              Every recording is the real DOM, scrubbable frame by frame — rage clicks,
              form abandons, and dead ends included. No sampling, no "estimated" anything.
            </p>
          </div>
          <div className={styles.diagram}>
            <div className={styles.scrub}>
              <div className={styles.scrubTrack}>
                <span className={styles.scrubFill} />
                <span className={styles.scrubDot} />
              </div>
              <div className={`${styles.scrubTime} ${styles.mono}`}>
                <span>1:14</span>
                <span>3:02</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.band} data-flip="1" data-reveal>
        <div className={styles.bandInner}>
          <div className={styles.bandText}>
            <p className={styles.eyebrow}>Researcher</p>
            <h2>An AI that already watched every session.</h2>
            <p>
              Ask it in plain language — &ldquo;why do mobile signups drop on step two?&rdquo;
              — and it answers with the actual evidence: real charts, real sessions, cited.
            </p>
          </div>
          <div className={styles.diagram}>
            <div className={styles.stream}>
              <span className={styles.streamLine} style={{ width: '92%' }} />
              <span className={styles.streamLine} style={{ width: '68%' }} />
              <span className={styles.streamLine} style={{ width: '80%' }} />
              <span className={styles.streamCursor}>answering&hellip;</span>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.band} data-reveal>
        <div className={styles.bandInner}>
          <div className={styles.bandText}>
            <p className={styles.eyebrow}>Timeline &amp; Clusters</p>
            <h2>See the pattern before you read a single session.</h2>
            <p>
              Traffic, friction, and devices laid out over time, with visitors grouped
              by how they actually behave — not by who they claim to be.
            </p>
          </div>
          <div className={styles.diagram}>
            <div className={styles.combo}>
              <div className={styles.hist} aria-hidden>
                {[30, 55, 40, 90, 60, 45, 70].map((h, i) => (
                  <span key={i} className={styles.histBar} data-hi={i === 3 ? '1' : undefined} style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className={styles.dots} aria-hidden>
                <span className={styles.dot} style={{ top: '10%', left: '20%' }} />
                <span className={styles.dot} style={{ top: '35%', left: '55%' }} />
                <span className={styles.dot} style={{ top: '60%', left: '15%' }} />
                <span className={styles.dot} data-hi="1" style={{ top: '45%', left: '38%' }} />
                <span className={styles.dot} style={{ top: '20%', left: '75%' }} />
                <span className={styles.dot} style={{ top: '70%', left: '60%' }} />
                <span className={styles.dot} style={{ top: '80%', left: '30%' }} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.band} data-flip="1" data-reveal>
        <div className={styles.bandInner}>
          <div className={styles.bandText}>
            <p className={styles.eyebrow}>Tags</p>
            <h2>Visitors sort themselves, automatically.</h2>
            <p>
              Rules watch every session as it happens — browser, device, source, duration,
              intent — and tag it the moment it qualifies. No spreadsheets.
            </p>
          </div>
          <div className={styles.diagram}>
            <div className={styles.pills}>
              <span className={styles.pill}>Returning</span>
              <span className={styles.pill} data-brass="1">Signed up</span>
              <span className={styles.pill}>Mobile</span>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.closing} data-reveal>
        <div className={styles.closingInner}>
          <p className={styles.closingClaim}>
            Your visitors&rsquo; sessions. Your server. Nobody else&rsquo;s.
          </p>
          <Link href="/login" className={styles.loginBtn}>
            Log in <span aria-hidden>&rarr;</span>
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
