// The timeline chart's switchable measures — client-safe (no DB
// imports) so the 'use client' chart can import the values without
// dragging server-only modules into the browser bundle.
// Each measure stacks by its most informative lens: sessions by
// traffic source, clicks by device, engagement by new-vs-returning,
// frustration by signal kind, tags by tag.
export const TIMELINE_METRICS = {
  sessions: { label: 'Sessions', noun: 'sessions', hint: 'Recorded visits per slot, stacked by traffic source.' },
  clicks: { label: 'Clicks', noun: 'clicks', hint: 'Clicks captured in analyzed sessions, stacked by the visitor’s device. Sessions still awaiting analysis contribute none.' },
  engaged: { label: 'Engaged 30s+', noun: 'engaged sessions', hint: 'Sessions lasting at least 30 seconds, split between first-time and returning visitors.' },
  frustration: { label: 'Frustration', noun: 'friction signals', hint: 'Frustration signals detected per slot, stacked by kind — a session can contribute several.' },
  tags: { label: 'Tags', noun: 'tag marks', hint: 'Tagged sessions per slot, stacked by tag. A session counts once per tag it carries.' },
} as const;
export type TimelineMetric = keyof typeof TIMELINE_METRICS;
