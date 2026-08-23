/**
 * Shared session-length cap logic, used by both the ingest server routes and
 * the browser tracker so the cap can't drift between them.
 *
 * The cap is per-project (projects.max_session_minutes, default 5). The
 * server enforces its project's value; the tracker starts from the
 * default and adopts the server's value from the first events response.
 *
 * Browser-safe: pure functions only, no Node APIs (this module is bundled into
 * public/tracker.js).
 */

/** Default hard cap on a single recorded session's length. */
export const MAX_SESSION_DURATION_MS = 5 * 60 * 1000;

/**
 * Duration of a session as the recorded video span (`latestEventTs - startedAt`),
 * floored at 0 and clamped to the cap. Prevents the old
 * `now() - startedAt` formula from reporting hours for sessions that resumed
 * across many page loads.
 */
export function cappedDurationMs(startedAtMs: number, latestEventTs: number, capMs: number = MAX_SESSION_DURATION_MS): number {
  return Math.min(Math.max(0, latestEventTs - startedAtMs), capMs);
}

/**
 * Split a batch of events at the cap cutoff (`startedAt + cap`). Events past the
 * cutoff are dropped so the stored blob can't grow past the cap. Events with no
 * timestamp are kept — rrweb always emits one, so a missing timestamp is exotic
 * and we'd rather keep the data than silently lose it.
 */
export function splitAtCap<T extends { ts: number | null }>(
  events: T[],
  startedAtMs: number,
  capMs: number = MAX_SESSION_DURATION_MS,
): { kept: T[]; droppedAny: boolean } {
  const cutoffMs = startedAtMs + capMs;
  const kept: T[] = [];
  let droppedAny = false;
  for (const e of events) {
    if (e.ts == null || e.ts <= cutoffMs) kept.push(e);
    else droppedAny = true;
  }
  return { kept, droppedAny };
}

/**
 * Whether a persisted client session has aged past the cap. When true, the next
 * page load should start a FRESH session instead of resuming the dead one — this
 * is what stops a long browse (many pages, small gaps) from living as one
 * ever-growing session.
 */
export function isSessionExpired(startedAtMs: number, nowMs: number, capMs: number = MAX_SESSION_DURATION_MS): boolean {
  return nowMs - startedAtMs >= capMs;
}
