'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TimelineBucket } from '@/lib/timeline';
import { TIMELINE_METRICS, type TimelineMetric } from '@/lib/timeline-metrics';
import { Card } from '@/components/ui/card';
import { SOURCE_CATEGORIES, SOURCE_META } from '@/lib/traffic-source';
import { TAG_COLOR_HEX, isValidTagColor } from '@/lib/tag-colors';

const W = 760;
const H = 430;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 20;
const PAD_B = 36;
const SEG_GAP = 2;   // 2px surface gap between stacked segments

interface Hover { bucket: TimelineBucket; x: number; y: number }
interface StackSeg { key: string; label: string; color: string; v: number }

const tagHex = (color: string) => (isValidTagColor(color) ? TAG_COLOR_HEX[color] : TAG_COLOR_HEX.gray);

// Fixed stack orders (key, label, color) — grayscale zinc ramps.
const DEVICE_ORDER: [string, string, string][] = [
  ['desktop', 'Desktop', '#18181b'],
  ['mobile', 'Mobile', '#71717a'],
  ['tablet', 'Tablet', '#a1a1aa'],
];
const VISITOR_ORDER: [string, string, string][] = [
  ['new', 'New visitors', '#18181b'],
  ['returning', 'Returning', '#a1a1aa'],
];
const FRICTION_ORDER: [string, string, string][] = [
  ['dead_click', 'Dead clicks', '#18181b'],
  ['rage_click', 'Rage clicks', '#3f3f46'],
  ['form_abandon', 'Forms abandoned', '#52525b'],
  ['refresh_loop', 'Refresh loops', '#71717a'],
  ['uturn', 'U-turns', '#a1a1aa'],
  ['pogo_stick', 'Pogo-sticking', '#d4d4d8'],
];

/** Stacked volume per time slot with a switchable measure: sessions,
 * clicks, engaged, frustration (each stacked by traffic source) or
 * tagged sessions (stacked by tag). Owns the control row (range pills
 * passed in as a slot, measure chips beside them) so the selectors sit
 * together outside the chart card; trend chips render inside the card.
 * Hover a bar for the breakdown; click to open that time slice. */
export function TimelineChart({ buckets, bucketMs, sessionsBasePath, tagMeta, rangeSlot, analysisSlot, trendsSlot, patternsSlot }: {
  buckets: TimelineBucket[];
  bucketMs: number;
  sessionsBasePath: string;
  tagMeta: Record<string, { color: string }>;
  rangeSlot?: React.ReactNode;
  analysisSlot?: React.ReactNode;
  trendsSlot?: React.ReactNode;
  patternsSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const [metric, setMetric] = useState<TimelineMetric>('sessions');
  const [hover, setHover] = useState<Hover | null>(null);

  // Tags in fixed order (busiest first across the window) so the stack
  // and legend never reshuffle between buckets.
  const tagOrder = useMemo(() => {
    const sums = new Map<string, number>();
    for (const b of buckets) for (const [name, n] of Object.entries(b.byTag)) sums.set(name, (sums.get(name) ?? 0) + n);
    return [...sums.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [buckets]);

  // Each measure stacks by its most informative lens; every non-tag
  // stack keeps the grayscale ramp, in a fixed order.
  const stacksOf = (b: TimelineBucket): StackSeg[] => {
    switch (metric) {
      case 'tags':
        return tagOrder.map((name) => ({ key: name, label: name, color: tagHex(tagMeta[name]?.color ?? 'gray'), v: b.byTag[name] ?? 0 }));
      case 'clicks':
        return DEVICE_ORDER.map(([key, label, color]) => ({ key, label, color, v: b.clicksByDevice[key] ?? 0 }));
      case 'engaged':
        return VISITOR_ORDER.map(([key, label, color]) => ({ key, label, color, v: b.engagedByVisitor[key as 'new' | 'returning'] ?? 0 }));
      case 'frustration':
        return FRICTION_ORDER.map(([key, label, color]) => ({ key, label, color, v: b.frictionByKind[key] ?? 0 }));
      default:
        return SOURCE_CATEGORIES.map((s) => ({ key: s, label: SOURCE_META[s].label, color: SOURCE_META[s].color, v: b.bySource[s] }));
    }
  };

  const totalOf = (b: TimelineBucket) => stacksOf(b).reduce((a, s) => a + s.v, 0);

  const maxTotal = Math.max(1, ...buckets.map(totalOf));
  // Scale tops out at a clean multiple of 10 so every 10% line labels an
  // integer, and the axis always runs 0..100% of the scale.
  const niceMax = Math.max(10, Math.ceil(maxTotal / 10) * 10);
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / buckets.length;
  const barW = Math.max(3, slot * 0.86);

  const activeKeys = useMemo(() => {
    const present = new Set<string>();
    for (const b of buckets) for (const s of stacksOf(b)) if (s.v > 0) present.add(s.key);
    return present;
    // stacksOf closes over metric/tagOrder — both are deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, metric, tagOrder]);

  const legend: StackSeg[] = (buckets[0] ? stacksOf(buckets[0]) : []).filter((s) => activeKeys.has(s.key));

  const hourly = bucketMs < 86_400_000;
  // Fixed UTC: buckets are cut on UTC boundaries, and the server and
  // the viewer's browser must render identical text (hydration).
  const fmtBucket = (start: number) => hourly
    ? new Date(start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : new Date(start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

  const gotoSlice = (b: TimelineBucket) => {
    const from = new Date(b.start).toISOString();
    const to = new Date(b.start + bucketMs).toISOString();
    router.push(`${sessionsBasePath}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&range=all`);
  };

  const metricKeys = (Object.keys(TIMELINE_METRICS) as TimelineMetric[])
    .filter((m) => m !== 'tags' || tagOrder.length > 0);

  // Contextual window totals for each chip's hover text — always
  // anchored against the session base ("engaged out of how many?").
  const sum = (pick: (b: TimelineBucket) => number) => buckets.reduce((a, b) => a + pick(b), 0);
  const chipTitle = (m: TimelineMetric): string => {
    const S = sum((b) => b.total);
    const shr = (n: number) => (S > 0 ? ` (${Math.round((100 * n) / S)}%)` : '');
    const head = m === 'sessions' ? `${S.toLocaleString()} sessions in this window.`
      : m === 'clicks' ? `${sum((b) => Object.values(b.clicksByDevice).reduce((a, v) => a + v, 0)).toLocaleString()} clicks across ${S.toLocaleString()} sessions.`
      : m === 'engaged' ? `${sum((b) => b.engagedByVisitor.new + b.engagedByVisitor.returning).toLocaleString()} of ${S.toLocaleString()} sessions${shr(sum((b) => b.engagedByVisitor.new + b.engagedByVisitor.returning))}.`
      : m === 'frustration' ? `${sum((b) => Object.values(b.frictionByKind).reduce((a, v) => a + v, 0)).toLocaleString()} signals in ${sum((b) => b.frustrated).toLocaleString()} of ${S.toLocaleString()} sessions${shr(sum((b) => b.frustrated))}.`
      : `${sum((b) => b.tagged).toLocaleString()} of ${S.toLocaleString()} sessions tagged${shr(sum((b) => b.tagged))}.`;
    return `${head} ${TIMELINE_METRICS[m].hint}`;
  };

  return (
    <div className="space-y-4">
      <style>{`
        @keyframes bar-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        .bar-rise { animation: bar-rise 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards; transform-box: fill-box; transform-origin: bottom; }
        @media (prefers-reduced-motion: reduce) { .bar-rise { animation: none; } }
      `}</style>

      {/* control row: range pills (slot) + measure switcher — each chip
          explains itself on hover */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {rangeSlot}
        <div className="flex flex-wrap gap-1.5 justify-end">
          {metricKeys.map((m) => (
            <button
              key={m}
              type="button"
              title={chipTitle(m)}
              onClick={() => { setMetric(m); setHover(null); }}
              className={`rounded-full px-3.5 py-1 text-sm font-medium border transition-colors ${
                m === metric ? 'bg-foreground text-background border-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {TIMELINE_METRICS[m].label}
            </button>
          ))}
        </div>
      </div>

      {analysisSlot}

      <Card className="p-4 space-y-3">
      {trendsSlot}
      <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
           aria-label={`${TIMELINE_METRICS[metric].label} over time, stacked by ${metric === 'tags' ? 'tag' : 'traffic source'}`}>
        {/* grid: a line and label at every 10% of the scale, up to 100% */}
        {Array.from({ length: 11 }, (_, i) => i).map((i) => {
          const v = (niceMax * i) / 10;
          const y = PAD_T + plotH - (v / niceMax) * plotH;
          return (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="stroke-border" strokeWidth="1"
                    strokeDasharray={i % 5 === 0 ? undefined : '3 5'} opacity={i % 5 === 0 ? 0.9 : 0.55} />
              <text x={PAD_L - 6} y={y + 3.5} textAnchor="end" className="fill-muted-foreground" fontSize="10" style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</text>
            </g>
          );
        })}

        {/* bars — bold, crisp, rising on load and on measure switch */}
        {buckets.map((b, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          const total = totalOf(b);
          let yCursor = PAD_T + plotH;
          const segs = stacksOf(b).map((s) => {
            if (s.v === 0) return null;
            const h = Math.max(2, (s.v / niceMax) * plotH - SEG_GAP);
            yCursor -= h + SEG_GAP;
            return { ...s, y: yCursor + SEG_GAP, h };
          }).filter((seg): seg is NonNullable<typeof seg> => seg !== null);
          const topY = segs.length ? segs[segs.length - 1].y : PAD_T + plotH;
          return (
            <g key={b.start}
               style={{ cursor: total > 0 ? 'pointer' : 'default' }}
               onMouseEnter={() => total > 0 && setHover({ bucket: b, x: x + barW / 2, y: topY })}
               onMouseLeave={() => setHover(null)}
               onClick={() => total > 0 && gotoSlice(b)}>
              {/* invisible hit target taller than the mark */}
              <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" />
              <g key={metric} className="bar-rise" style={{ animationDelay: `${i * 18}ms` }}>
                {segs.map((seg, si) => (
                  <rect key={seg.key} x={x} y={seg.y} width={barW} height={seg.h}
                        rx={si === segs.length - 1 ? 1 : 0}
                        shapeRendering="crispEdges"
                        fill={seg.color} />
                ))}
              </g>
              {metric === 'sessions' && b.spike && (
                <g>
                  <circle cx={x + barW / 2} cy={topY - 10} r="3" fill="currentColor" opacity="0.85" />
                  <text x={x + barW / 2} y={topY - 16} textAnchor="middle" fontSize="9.5" className="fill-foreground" fontWeight="600">
                    {b.spike.factor}×
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* x labels — every few buckets to avoid collisions */}
        {buckets.map((b, i) => {
          const every = Math.ceil(buckets.length / 8);
          if (i % every !== 0) return null;
          const x = PAD_L + i * slot + slot / 2;
          return (
            <text key={`x${b.start}`} x={x} y={H - PAD_B + 16} textAnchor="middle" fontSize="10" className="fill-muted-foreground">
              {fmtBucket(b.start)}
            </text>
          );
        })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-card p-2.5 shadow-md text-xs min-w-40"
          style={{
            left: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
            // Keep the tooltip inside the card: flip below the bar top
            // when it's near the chart's upper edge, and pin toward the
            // opposite side near the left/right edges.
            transform: `translate(${hover.x / W < 0.12 ? '-10%' : hover.x / W > 0.88 ? '-90%' : '-50%'}, ${hover.y / H < 0.4 ? '14px' : 'calc(-100% - 10px)'})`,
          }}
        >
          <div className="font-medium mb-1">
            {fmtBucket(hover.bucket.start)} · {totalOf(hover.bucket)} {TIMELINE_METRICS[metric].noun}
            {metric === 'sessions' && hover.bucket.spike && <span className="ml-1 text-muted-foreground">({hover.bucket.spike.factor}× normal)</span>}
          </div>
          {stacksOf(hover.bucket).filter((s) => s.v > 0).map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 leading-5">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto tabular-nums">{s.v}</span>
            </div>
          ))}
          <div className="text-muted-foreground mt-1">click to open these sessions</div>
        </div>
      )}
      </div>

      {/* legend — identity never by color alone */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
        {legend.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {hourly && <span className="ml-auto text-xs text-muted-foreground">times in UTC</span>}
      </div>

      {patternsSlot}
      </Card>
    </div>
  );
}
