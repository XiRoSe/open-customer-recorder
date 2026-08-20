// Tracker - works in browser only. Imported by app code OR bundled
// into public/tracker.js. Talks to the simpler /v2/events endpoint:
// the client picks the session UUID, every POST is keepalive, and the
// server upserts the row on the first POST. No /start round-trip, no
// JWT, no ensureSession dance.
import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { MAX_SESSION_DURATION_MS, isSessionExpired } from './session-cap';
import { makeUrlChangeEvent } from './url-timeline';

export interface InitOptions {
  projectKey: string;
  apiOrigin?: string;
  privacyMode?: 'default' | 'mask_all_inputs' | 'strict';
  user?: { userId?: string; email?: string; displayName?: string };
}

interface PersistedState {
  sid: string;
  startedAt: number;
  pageCount: number;
  expires: number;
  pageUrl: string;
}

const ANON_KEY = 'mega_anon_id';
const SESSION_KEY = 'mega_session_v2';
// Resume window matches MAX_SESSION_DURATION_MS so a restored session
// can never outlive the cap (startedAt is preserved on resume).
const SESSION_TTL_MS = 5 * 60 * 1000;
// Small flush interval keeps the in-flight loss window tiny. With
// keepalive on every POST a cancelled flush only loses the last 2 s
// of mutations at most — and the next page-load's rrweb will emit a
// fresh FullSnapshot anyway, so replays stay coherent.
const FLUSH_INTERVAL_MS = 2 * 1000;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVITY_CHECK_INTERVAL_MS = 30 * 1000;
// Browsers cap keepalive POST bodies to ~64 KB total. We compress
// before send, so this is the gzipped-byte budget.
const MAX_KEEPALIVE_BYTES = 60_000;

function getOrCreateAnonId(): string {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = `anon-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    return `anon-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient browsers — RFC 4122 v4 manually.
  const r = (n: number) => Math.floor(Math.random() * n);
  const h = (n: number) => r(n).toString(16);
  let s = '';
  for (let i = 0; i < 8; i++) s += h(16);
  s += '-';
  for (let i = 0; i < 4; i++) s += h(16);
  s += '-4';
  for (let i = 0; i < 3; i++) s += h(16);
  s += '-' + ((r(4) + 8).toString(16));
  for (let i = 0; i < 3; i++) s += h(16);
  s += '-';
  for (let i = 0; i < 12; i++) s += h(16);
  return s;
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedState;
    if (!p.sid) return null;
    if (Date.now() > p.expires) return null;
    // Past the hard cap → don't resume. The next page starts a fresh session
    // so a long browse (many pages, small gaps) can't live as one
    // ever-growing session that blows past the 5-minute cap.
    if (isSessionExpired(p.startedAt, Date.now())) return null;
    return p;
  } catch {
    return null;
  }
}

function persist(s: { sid: string; startedAt: number; pageCount: number; pageUrl: string }) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, expires: Date.now() + SESSION_TTL_MS } satisfies PersistedState));
  } catch {}
}

function clearPersisted() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function eventsToNdjsonBytes(events: eventWithTime[]): Uint8Array {
  const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return new TextEncoder().encode(ndjson);
}

export function initRecorder(opts: InitOptions): { stop: () => void; identify: (u: InitOptions['user']) => void } {
  const persisted = loadPersisted();
  const sid = persisted?.sid || uuid();
  const anonId = getOrCreateAnonId();
  const apiOrigin = opts.apiOrigin || (typeof window !== 'undefined' ? window.location.origin : '');
  const startedAt = persisted?.startedAt || Date.now();
  let pageCount = persisted?.pageCount || 1;
  let lastUrl = typeof window !== 'undefined' ? window.location.href : '';

  // If we resumed and the URL changed, count this as a new page.
  if (persisted && persisted.pageUrl !== lastUrl) {
    pageCount += 1;
  }
  persist({ sid, startedAt, pageCount, pageUrl: lastUrl });

  // Buffer of events captured by rrweb but not yet ack'd by the server.
  // Drained only on POST success (splice from front) — never optimistically,
  // because a cancelled fetch would otherwise silently lose Meta+FullSnapshot.
  let buffer: eventWithTime[] = [];
  let flushTimer: number | null = null;
  let activityTimer: number | null = null;
  let maxDurationTimer: number | null = null;
  let stopFn: (() => void) | null = null;
  let lastInteractionAt = Date.now();
  let stopped = false;
  // Serialize flushes via a promise chain so concurrent calls can't
  // race on buffer.splice.
  let flushChain: Promise<void> = Promise.resolve();
  let eagerFirstFlushScheduled = false;
  let pendingIdentify: NonNullable<InitOptions['user']> | null = opts.user ?? null;

  function buildEventsUrl(): string {
    const u = new URL(`${apiOrigin}/api/ingest/v2/events`);
    u.searchParams.set('k', opts.projectKey);
    u.searchParams.set('sid', sid);
    u.searchParams.set('a', anonId);
    u.searchParams.set('u', lastUrl);
    u.searchParams.set('p', String(pageCount));
    // Traffic source. Sent on every POST for simplicity; the server only
    // stores it when it creates the session row, so it reflects how the
    // visit began. Additive to the wire protocol — old servers ignore it.
    try {
      const ref = typeof document !== 'undefined' ? document.referrer : '';
      if (ref) u.searchParams.set('r', ref.slice(0, 512));
    } catch {}
    return u.toString();
  }

  function startRecording() {
    const maskAll = opts.privacyMode === 'mask_all_inputs' || opts.privacyMode === 'strict';
    const maskSelector = opts.privacyMode === 'strict' ? '[data-mega-mask]' : undefined;

    // rrweb interaction sources that count as user activity
    // 1=MouseMove, 2=MouseInteraction, 3=Scroll, 5=Input, 6=TouchMove, 12=Drag
    const INTERACTION_SOURCES = new Set([1, 2, 3, 5, 6, 12]);

    // Push a synthetic type=5 (Custom) event so the next broken session
    // tells us what threw, even without phone-side DevTools access.
    function pushDiagnostic(tag: string, payload: Record<string, unknown>) {
      try {
        buffer.push({ type: 5, data: { tag, payload }, timestamp: Date.now() } as eventWithTime);
      } catch {}
    }

    stopFn = record({
      emit: (e: eventWithTime) => {
        // Wrap our handler so a single bad event can't kill recording. A
        // throw here in earlier builds was caught silently by rrweb and
        // made Meta+FullSnapshot vanish on Android Chrome.
        try {
          if (e.type === 3) {
            const src = (e.data as { source?: number } | undefined)?.source;
            if (typeof src === 'number' && INTERACTION_SOURCES.has(src)) {
              lastInteractionAt = Date.now();
            }
          }
          buffer.push(e);
          // The Meta(4)+FullSnapshot(2) pair is REQUIRED for the player to
          // render anything. Without them, mutations reference nonexistent
          // node IDs and the replay is blank. Flush them ASAP — don't wait
          // for the 2s timer — so a fast bounce can't lose them.
          if (e.type === 2 && !eagerFirstFlushScheduled) {
            eagerFirstFlushScheduled = true;
            setTimeout(() => { void flush(); }, 0);
          }
        } catch (err) {
          console.warn('[recorder] emit', err);
          pushDiagnostic('mega-emit-error', {
            message: String((err as Error)?.message ?? err),
            evType: (e as { type?: number })?.type,
          });
        }
      },
      maskAllInputs: maskAll,
      maskTextSelector: maskSelector,
      sampling: {
        mousemove: 50,
        scroll: 150,
        media: 1000,
      },
      // inlineStylesheet=false preserves CSS var() shorthand which rrweb's
      // inlining serializer was breaking.
      inlineStylesheet: false,
      // collectFonts: true was inlining @font-face data into FullSnapshot.
      // On font-heavy mobile renders (many custom @font-face weights)
      // rrweb's font handler appears to throw mid-serialization on Android Chrome 138,
      // causing it to skip emitting Meta+FullSnapshot entirely — replays
      // came back blank with only mutations. Replay still renders fonts
      // by URL when available; that's good enough.
      collectFonts: false,
      checkoutEveryNms: 5 * 60 * 1000,
      // Without this rrweb swallows errors silently. Surface them so the
      // next blank-replay session leaves a breadcrumb.
      errorHandler: (err) => {
        console.warn('[recorder] rrweb', err);
        pushDiagnostic('mega-rrweb-error', {
          message: String((err as Error)?.message ?? err),
          stack: String((err as Error)?.stack ?? '').slice(0, 400),
        });
        // Returning true tells rrweb the error is "handled" — recording
        // continues instead of being torn down.
        return true;
      },
    } as Parameters<typeof record>[0]) || null;

    flushTimer = window.setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    activityTimer = window.setInterval(checkActivity, ACTIVITY_CHECK_INTERVAL_MS);
    // Exact hard stop at startedAt + MAX_SESSION_DURATION_MS. The 30 s
    // polling check would otherwise let a session overshoot by up to one
    // interval; with this we honor the cap to the millisecond.
    const remainingMs = Math.max(0, startedAt + MAX_SESSION_DURATION_MS - Date.now());
    maxDurationTimer = window.setTimeout(() => {
      console.log('[recorder] session ended — max duration', Math.round((Date.now() - startedAt) / 1000), 's');
      stop(true);
    }, remainingMs);
    hookHistory();

    // beforeunload / pagehide are the only paths where the page is about
    // to die — those must use keepalive (capped at ~64 KB body) so the
    // POST survives unload. Regular polls and the eager first flush use
    // plain fetch with no size cap, so a heavy Meta+FullSnapshot ships.
    const onUnload = () => { void flush({ end: false, keepalive: true }); };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);

    // visibilitychange "hidden" fires before pagehide on mobile / tab
    // close and may be the last hook we get — keepalive needed.
    const onVis = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        void flush({ keepalive: true });
      } else {
        lastInteractionAt = Date.now();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
  }

  function checkActivity() {
    if (stopped) return;
    const idle = Date.now() - lastInteractionAt;
    const age = Date.now() - startedAt;
    if (idle > INACTIVITY_TIMEOUT_MS) {
      console.log('[recorder] session ended — idle', Math.round(idle / 1000), 's');
      stop(true);
    } else if (age > MAX_SESSION_DURATION_MS) {
      console.log('[recorder] session ended — max duration', Math.round(age / 1000), 's');
      stop(true);
    }
  }

  function hookHistory() {
    const onUrl = (url: string) => {
      if (url === lastUrl) return;
      // Mark the route change in the replay stream so the player's URL
      // bar can follow SPA navigations (hard loads get a Meta event).
      try {
        buffer.push(makeUrlChangeEvent(url, Date.now()) as eventWithTime);
      } catch {}
      // Drain before the new page's mutations pile on.
      void flush();
      lastUrl = url;
      pageCount += 1;
      eagerFirstFlushScheduled = false;
      persist({ sid, startedAt, pageCount, pageUrl: lastUrl });
    };
    const origPush = history.pushState;
    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      const r = origPush.apply(this, args);
      onUrl(window.location.href);
      return r;
    };
    const origReplace = history.replaceState;
    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const r = origReplace.apply(this, args);
      onUrl(window.location.href);
      return r;
    };
    window.addEventListener('popstate', () => onUrl(window.location.href));
    window.addEventListener('hashchange', () => onUrl(window.location.href));
  }

  /**
   * Send a chunk of events. Events stay in the buffer until the server
   * returns 2xx. Concurrent flushes serialize via flushChain.
   *
   * `end: true` signals the server to set ended_at — fired from the
   * explicit stop() path (idle timeout, max-duration cap, or programmatic).
   * `keepalive: true` is set only when called from a path where the page
   * may die before the POST completes (beforeunload, pagehide, visibility
   * hidden). It costs a ~64 KB body cap, so we keep the default off so a
   * heavy initial Meta+FullSnapshot (font-heavy mobile pages can produce
   * a snapshot well over 64 KB once rrweb inlines @font-face data) can
   * ship intact rather than getting stuck at the head of the buffer.
   */
  function flush(o: { end?: boolean; keepalive?: boolean } = {}): Promise<void> {
    const next = flushChain.then(() => doFlush(o)).catch(() => {});
    flushChain = next;
    return next;
  }

  async function doFlush(o: { end?: boolean; keepalive?: boolean }): Promise<void> {
    if (buffer.length === 0 && !o.end) return;

    const snapshot = buffer.slice();
    const headers: Record<string, string> = {
      'content-type': 'application/x-ndjson',
    };
    if (o.end) headers['x-mega-end'] = '1';

    let toSend: Uint8Array | null = null;
    let sentCount = 0;

    if (snapshot.length > 0) {
      const ndjson = eventsToNdjsonBytes(snapshot);
      let gz: Uint8Array;
      try {
        gz = await gzipBytes(ndjson);
      } catch {
        return; // CompressionStream not supported; bail
      }
      headers['content-encoding'] = 'gzip';

      if (!o.keepalive || gz.length <= MAX_KEEPALIVE_BYTES) {
        // Plain fetch path (or keepalive payload that already fits): send
        // the whole gzipped buffer. No body-size cap when keepalive is off.
        toSend = gz;
        sentCount = snapshot.length;
      } else {
        // Keepalive payload exceeds the ~64 KB body cap. Find the largest
        // prefix that fits. Meta(4)+FullSnapshot(2) are at the front and
        // MUST survive (without them mutations reference nonexistent node
        // IDs); drop mutations from the tail.
        let lo = 1, hi = snapshot.length, best = 1, bestGz: Uint8Array | null = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const candidate = await gzipBytes(eventsToNdjsonBytes(snapshot.slice(0, mid)));
          if (candidate.length <= MAX_KEEPALIVE_BYTES) {
            best = mid;
            bestGz = candidate;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (!bestGz) return; // even 1 event won't fit; retry next round
        toSend = bestGz;
        sentCount = best;
      }
    }

    try {
      const res = await fetch(buildEventsUrl(), {
        method: 'POST',
        headers,
        body: toSend ? new Blob([toSend as BlobPart]) : null,
        keepalive: !!o.keepalive,
      });
      if (res.status === 413 || res.status === 410) {
        // 413: session blob over the byte cap. 410: server has closed
        // the session (past the 5-min video cap). Both mean "stop
        // sending forever" — drop the buffer so a future flush from a
        // pending timer can't re-POST.
        console.warn('[recorder] server closed session', res.status);
        buffer = [];
        stop(false);
        return;
      }
      if (!res.ok) {
        // Don't drain — events stay queued for the next attempt.
        return;
      }
      if (sentCount > 0) buffer.splice(0, sentCount);
      // Refresh persisted TTL on success.
      persist({ sid, startedAt, pageCount, pageUrl: lastUrl });

      // Send identify after the first successful POST (which guarantees
      // the session row exists server-side).
      if (pendingIdentify) {
        const u = pendingIdentify;
        pendingIdentify = null;
        void sendIdentify(u);
      }
    } catch {
      // Network error / fetch cancellation — events stay in buffer.
    }
  }

  async function sendIdentify(u: NonNullable<InitOptions['user']>) {
    try {
      const url = new URL(`${apiOrigin}/api/ingest/v2/identify`);
      url.searchParams.set('k', opts.projectKey);
      url.searchParams.set('sid', sid);
      url.searchParams.set('a', anonId);
      await fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(u),
        keepalive: true,
      });
    } catch {}
  }

  function stop(sendEnd: boolean) {
    if (stopped) return;
    stopped = true;
    stopFn?.();
    if (flushTimer) clearInterval(flushTimer);
    if (activityTimer) clearInterval(activityTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    // Keepalive: stop() is called from React unmount cleanup which can
    // fire mid-navigation, plus from idle/max-duration paths where the
    // user may close the tab any moment after — better to take the 64 KB
    // cap than to lose the trailing chunk.
    void flush({ end: sendEnd, keepalive: true });
    clearPersisted();
  }

  // Start recording immediately. No /start round-trip, no awaiting.
  // rrweb's Meta+FullSnapshot land in buffer within ~50ms; the eager
  // flush dispatches them right after.
  try {
    startRecording();
  } catch (e) {
    console.warn('[recorder] init', e);
  }

  return {
    stop: () => stop(true),
    identify(u) {
      if (!u) return;
      pendingIdentify = u;
      // If the session row already exists, fire identify now.
      // Otherwise the next successful flush will do it.
      if (buffer.length === 0) void sendIdentify(u);
    },
  };
}
