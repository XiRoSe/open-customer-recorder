import Link from 'next/link';

// Shared time-range options for the sessions list and users list.
// Keep these aligned — a user clicking through from /users?range=7d
// expects the sessions list to honor the same window.
export const RANGES: { label: string; value: string; hours: number | null }[] = [
  { label: '3h', value: '3h', hours: 3 },
  { label: '6h', value: '6h', hours: 6 },
  { label: '12h', value: '12h', hours: 12 },
  { label: '24h', value: '24h', hours: 24 },
  { label: '7d', value: '7d', hours: 24 * 7 },
  { label: '30d', value: '30d', hours: 24 * 30 },
  { label: 'All time', value: 'all', hours: null },
];

// Canonical default. Lives here (not as a magic string in buildHref /
// resolveRange) so the "no ?range= ⇒ default" URL convention can't
// silently desync from the fallback resolveRange returns.
export const DEFAULT_RANGE = '24h';

export function resolveRange(value: string | undefined) {
  return RANGES.find((r) => r.value === value) ?? RANGES.find((r) => r.value === DEFAULT_RANGE)!;
}

export function rangeCutoff(value: string | undefined): Date | null {
  const r = resolveRange(value);
  return r.hours !== null ? new Date(Date.now() - r.hours * 60 * 60 * 1000) : null;
}

interface Props {
  basePath: string;
  currentRange: string;
  extraParams?: Record<string, string | undefined>;
}

export function RangeTabs({ basePath, currentRange, extraParams }: Props) {
  const buildHref = (rangeValue: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) p.set(k, v);
    // Omit `range` in the URL when it's the default so the canonical
    // "fresh visit" URL is the short one.
    if (rangeValue !== DEFAULT_RANGE) p.set('range', rangeValue);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="flex items-center gap-1 text-sm" role="tablist" aria-label="Time range">
      {RANGES.map((r) => {
        const active = r.value === currentRange;
        return (
          <Link
            key={r.value}
            href={buildHref(r.value)}
            role="tab"
            aria-selected={active}
            className={
              active
                ? 'px-3 py-1 rounded-md bg-foreground text-background font-medium'
                : 'px-3 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors'
            }
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}
