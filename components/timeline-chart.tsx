'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TimelineBucket } from '@/lib/timeline';
import { SOURCE_CATEGORIES, SOURCE_META, type SourceCategory } from '@/lib/traffic-source';

const W = 760;
const H = 300;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 18;
const PAD_B = 34;
const SEG_GAP = 2;   // 2px surface gap between stacked segments
const BAR_GAP = 2;   // and between adjacent bars

interface Hover { bucket: TimelineBucket; x: number; y: number }

/** Stacked session volume by traffic source. Hover a bar for the
 * breakdown; click to open the sessions of that time slice. */
export function TimelineChart({ buckets, bucketMs, sessionsBasePath }: {
  buckets: TimelineBucket[];
  bucketMs: number;
  sessionsBasePath: string;
}) {
  const router = useRouter();
  const [hover, setHover] = useState<Hover | null>(null);

  const maxTotal = Math.max(1, ...buckets.map((b) => b.total));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const barW = Math.max(3, plotW / buckets.length - BAR_GAP);

  const activeSources = useMemo(
    () => SOURCE_CATEGORIES.filter((s) => buckets.some((b) => b.bySource[s] > 0)),
    [buckets],
  );

  const hourly = bucketMs < 86_400_000;
  const fmtBucket = (start: number) => hourly
    ? new Date(start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : new Date(start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

  const yTicks = useMemo(() => {
    const step = Math.max(1, Math.ceil(maxTotal / 4));
    return Array.from({ length: Math.floor(maxTotal / step) + 1 }, (_, i) => i * step);
  }, [maxTotal]);

  const gotoSlice = (b: TimelineBucket) => {
    const from = new Date(b.start).toISOString();
    const to = new Date(b.start + bucketMs).toISOString();
    router.push(`${sessionsBasePath}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&range=all`);
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
           aria-label="Sessions over time, stacked by traffic source">
        {/* recessive grid + y labels */}
        {yTicks.map((t) => {
          const y = PAD_T + plotH - (t / maxTotal) * plotH;
          return (
            <g key={t}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="stroke-border" strokeWidth="1" strokeDasharray="3 5" opacity="0.7" />
              <text x={PAD_L - 6} y={y + 3.5} textAnchor="end" className="fill-muted-foreground" fontSize="10" style={{ fontVariantNumeric: 'tabular-nums' }}>{t}</text>
            </g>
          );
        })}

        {/* bars */}
        {buckets.map((b, i) => {
          const x = PAD_L + i * (plotW / buckets.length) + BAR_GAP / 2;
          let yCursor = PAD_T + plotH;
          const segs = activeSources.map((s) => {
            const v = b.bySource[s];
            if (v === 0) return null;
            const h = Math.max(2, (v / maxTotal) * plotH - SEG_GAP);
            yCursor -= h + SEG_GAP;
            return { s, y: yCursor + SEG_GAP, h, v };
          }).filter((seg): seg is NonNullable<typeof seg> => seg !== null);
          const topY = segs.length ? segs[segs.length - 1].y : PAD_T + plotH;
          return (
            <g key={b.start}
               style={{ cursor: b.total > 0 ? 'pointer' : 'default' }}
               onMouseEnter={() => b.total > 0 && setHover({ bucket: b, x: x + barW / 2, y: topY })}
               onMouseLeave={() => setHover(null)}
               onClick={() => b.total > 0 && gotoSlice(b)}>
              {/* invisible hit target taller than the mark */}
              <rect x={x - BAR_GAP / 2} y={PAD_T} width={barW + BAR_GAP} height={plotH} fill="transparent" />
              {segs.map((seg, si) => (
                <rect key={seg.s} x={x} y={seg.y} width={barW} height={seg.h}
                      rx={si === segs.length - 1 ? 3 : 0}
                      fill={SOURCE_META[seg.s].color} />
              ))}
              {b.spike && (
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
          const x = PAD_L + i * (plotW / buckets.length) + barW / 2;
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
          style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(-50%, calc(-100% - 10px))' }}
        >
          <div className="font-medium mb-1">
            {fmtBucket(hover.bucket.start)} · {hover.bucket.total} {hover.bucket.total === 1 ? 'session' : 'sessions'}
            {hover.bucket.spike && <span className="ml-1 text-muted-foreground">({hover.bucket.spike.factor}× normal)</span>}
          </div>
          {activeSources.filter((s) => hover.bucket.bySource[s] > 0).map((s) => (
            <div key={s} className="flex items-center gap-1.5 leading-5">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: SOURCE_META[s].color }} />
              <span className="text-muted-foreground">{SOURCE_META[s].label}</span>
              <span className="ml-auto tabular-nums">{hover.bucket.bySource[s]}</span>
            </div>
          ))}
          <div className="text-muted-foreground mt-1">click to open these sessions</div>
        </div>
      )}

      {/* legend — identity never by color alone */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 px-1">
        {activeSources.map((s: SourceCategory) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: SOURCE_META[s].color }} />
            {SOURCE_META[s].label}
          </span>
        ))}
      </div>
    </div>
  );
}
