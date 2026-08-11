// Shared between the tracker (emits mega-url-change custom events on SPA
// route changes) and the replay player (builds a URL-per-moment timeline).
// Must stay dependency-free — it's bundled into public/tracker.js.

export const URL_CHANGE_TAG = 'mega-url-change';

export interface UrlTimelineEntry {
  timestamp: number;
  href: string;
}

export interface RawEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export function makeUrlChangeEvent(href: string, timestamp: number) {
  return { type: 5 as const, data: { tag: URL_CHANGE_TAG, payload: { href } }, timestamp };
}

/**
 * Extract the href off a raw rrweb event, if it carries one: a Meta event
 * (type 4, emitted on every full page load) or a mega-url-change custom
 * event (type 5, emitted by the tracker on SPA route changes). Shared by
 * the URL timeline builder and lib/tag-rules.ts's url_contains matching —
 * one definition of "what counts as a URL on this event".
 */
export function hrefOf(e: RawEvent): string | null {
  let href: unknown;
  if (e.type === 4) {
    href = (e.data as { href?: unknown } | null | undefined)?.href;
  } else if (e.type === 5) {
    const d = e.data as { tag?: unknown; payload?: { href?: unknown } } | null | undefined;
    if (d?.tag === URL_CHANGE_TAG) href = d.payload?.href;
  }
  return typeof href === 'string' && href.length > 0 ? href : null;
}

/**
 * Scan a session's rrweb events into a sorted URL timeline. Sources:
 * Meta events (type 4, every full page load — present in all sessions)
 * and mega-url-change custom events (SPA route changes — newer sessions).
 */
export function buildUrlTimeline(events: RawEvent[]): UrlTimelineEntry[] {
  const entries: UrlTimelineEntry[] = [];
  for (const e of events) {
    const href = hrefOf(e);
    if (href) entries.push({ timestamp: e.timestamp, href });
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries.filter((e, i) => i === 0 || e.href !== entries[i - 1].href);
}

/**
 * URL active at an absolute time (ms epoch, same clock as event
 * timestamps): the latest entry at or before timeMs. Times before the
 * first entry return the first URL so the bar is never blank while the
 * player sits at 0:00.
 */
export function urlAtTime(timeline: UrlTimelineEntry[], timeMs: number): string | null {
  if (timeline.length === 0) return null;
  let lo = 0;
  let hi = timeline.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].timestamp <= timeMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return timeline[best].href;
}
