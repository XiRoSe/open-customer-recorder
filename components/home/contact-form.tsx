'use client';
import { useState } from 'react';
import styles from '@/app/home.module.css';

/**
 * The reach-out form — registration is invite-only, so this is the
 * homepage's real conversion action. On success the form dissolves into
 * a self-drawing brass check with a mono LOGGED timestamp: the same
 * quiet instrument language as the rest of the page.
 */
export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // The hidden honeypot input travels with the real fields.
    const honeypot = (new FormData(e.currentTarget).get('company') as string) || '';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, message, company: honeypot }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? 'Something went wrong — try again.');
        return;
      }
      setSentAt(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch {
      setError('Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sentAt) {
    return (
      <div className={styles.contactDone}>
        <svg className={styles.contactCheck} viewBox="0 0 48 48" fill="none" aria-hidden>
          <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="2" className={styles.contactCheckRing} />
          <path d="M15 24.5 L21.5 31 L33 18.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.contactCheckMark} />
        </svg>
        <p className={styles.contactDoneText}>Received — you&rsquo;ll hear from us soon.</p>
        <p className={`${styles.contactDoneStamp} ${styles.mono}`}>LOGGED {sentAt}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={styles.contactForm}>
      <div className={styles.contactRow}>
        <label className={styles.contactField}>
          <span className={`${styles.contactLabel} ${styles.mono}`}>Full name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoComplete="name"
            className={styles.contactInput}
          />
        </label>
        <label className={styles.contactField}>
          <span className={`${styles.contactLabel} ${styles.mono}`}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={200}
            autoComplete="email"
            className={styles.contactInput}
          />
        </label>
      </div>
      <label className={styles.contactField}>
        <span className={`${styles.contactLabel} ${styles.mono}`}>What are you building?</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          maxLength={2000}
          rows={4}
          className={`${styles.contactInput} ${styles.contactTextarea}`}
        />
      </label>
      {/* Honeypot — hidden from people, tempting to bots. */}
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className={styles.contactTrap} aria-hidden />
      {error && <p className={styles.contactError}>{error}</p>}
      <button type="submit" disabled={busy} className={styles.ctaPrimary}>
        {busy ? 'Sending…' : <>Reach out <span aria-hidden>&rarr;</span></>}
      </button>
    </form>
  );
}
