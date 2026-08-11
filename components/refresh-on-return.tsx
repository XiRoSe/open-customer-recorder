'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Module-scoped, so it survives soft (client-side) navigations within the SPA.
// Lets us distinguish the initial page load (data already fresh) from a
// re-entry to the list — e.g. pressing Back after watching a replay.
let listMountedOnce = false;

/**
 * Keeps the sessions list in sync with per-admin viewed state when the user
 * returns to it.
 *
 * Pressing Back after watching a replay is a *soft* navigation: App Router
 * re-renders the list from its client Router Cache (stale — the session you
 * just watched still looks unviewed) and neither `pageshow` nor
 * `visibilitychange` fires. But the list's React tree DOES remount, so we
 * `router.refresh()` on every mount after the first to refetch fresh server
 * data. (The first mount is skipped because that render is already fresh.)
 *
 * Also handles bfcache restores (`pageshow`) and tab refocus
 * (`visibilitychange`). Renders nothing.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    if (listMountedOnce) router.refresh();
    else listMountedOnce = true;

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) router.refresh(); // restored from bfcache
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);
  return null;
}
