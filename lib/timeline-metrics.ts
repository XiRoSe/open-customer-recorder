// The timeline chart's switchable measures — client-safe (no DB
// imports) so the 'use client' chart can import the values without
// dragging server-only modules into the browser bundle.
// All but 'tags' stack by traffic source; 'tags' stacks by the
// sessions' tags instead.
export const TIMELINE_METRICS = {
  sessions: { label: 'Sessions', hint: 'Recorded visits per slot, stacked by traffic source.' },
  clicks: { label: 'Clicks', hint: 'Clicks captured in analyzed sessions, attributed to the session’s traffic source. Sessions still awaiting analysis contribute none.' },
  engaged: { label: 'Engaged 30s+', hint: 'Sessions lasting at least 30 seconds, stacked by traffic source.' },
  frustration: { label: 'Frustration', hint: 'Sessions with at least one frustration signal (rage clicks, dead clicks, abandoned forms, refresh loops), stacked by traffic source.' },
  tags: { label: 'Tags', hint: 'Tagged sessions per slot, stacked by tag. A session counts once per tag it carries.' },
} as const;
export type TimelineMetric = keyof typeof TIMELINE_METRICS;
