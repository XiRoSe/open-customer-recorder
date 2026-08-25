import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollReveal } from '@/components/home/scroll-reveal';
import { AskDemo } from '@/components/home/ask-demo';
import { ContactForm } from '@/components/home/contact-form';
import styles from './home.module.css';

const BRAND = 'PocketScience';

const TAPE = [
  'Replay every visit',
  'Plain-English answers',
  'Rage-click detection',
  'Session narratives',
  'Visitor clusters',
  'Auto-tags',
  'Self-hostable',
];

export const metadata: Metadata = {
  title: BRAND,
  description: 'Never guess again - just ask. Session replay + an AI researcher, in the cloud or on your own server.',
};

export default function Home() {
  return (
    <div className={styles.page}>
      <ScrollReveal />

      <header className={styles.hero}>
        <div className={styles.topBar}>
          <span className={styles.wordmark}>{BRAND}</span>
          <Link href="/login" className={styles.loginBtn}>
            Sign in <span aria-hidden>&rarr;</span>
          </Link>
        </div>

        <div className={styles.heroInner}>
          <div className={styles.heroCenter}>
            <p className={styles.eyebrow}>Your whole user-research lab. Pocket-sized.</p>
            <h1 className={styles.headline}>
              <span className={styles.headlineLine}><span>Never guess again.</span></span>
              <span className={styles.headlineLine}><span className={styles.headlineBrass}>Just ask.</span></span>
            </h1>

            <AskDemo />

            <div className={styles.heroCtas}>
              <div className={styles.ctaRow}>
                <Link href="/login" className={styles.ctaPrimary}>
                  Open the lab <span aria-hidden>&rarr;</span>
                </Link>
                <a href="#contact" className={styles.ctaSecondary}>
                  Contact us
                </a>
              </div>
              <p className={`${styles.ctaNote} ${styles.mono}`}>Cloud or self-hosted · invite-only</p>
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
              <a href="#contact" className={styles.ctaPrimary}>
                Start now <span aria-hidden>&rarr;</span>
              </a>
            </div>
            <div className={styles.choiceCard}>
              <span className={`${styles.choiceLabel} ${styles.mono}`}>Self-hosted</span>
              <h3>We deploy it on yours</h3>
              <p>One container on your own infrastructure, set up with us. Sessions never leave your hands.</p>
              <a href="#contact" className={styles.ctaGhost}>
                Contact us <span aria-hidden>&rarr;</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="contact" className={styles.contactBand} data-reveal>
        <div className={styles.contactInner}>
          <p className={styles.eyebrow}>Contact</p>
          <h2 className={styles.h2}>Contact Us</h2>
          <p className={styles.contactSub}>
            We&rsquo;re onboarding a few teams at a time. Leave a note - we reply within a day.
          </p>
          <ContactForm />
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
      </section>

      <div className={styles.footerBand}>
        <div className={styles.footer}>
          <span className={styles.mono}>{BRAND}</span>
          <Link href="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
