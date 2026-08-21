'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DimensionData, Segment } from '@/lib/user-segments';

export const SEGMENT_PALETTE = [
  '#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4', '#84cc16', '#d946ef',
];

const DIMENSION_LABELS: Record<string, string> = {
  overall: 'Overall',
  persona: 'Persona',
  intent: 'Intent',
  source: 'Source',
  experience: 'Experience',
};

const W = 760;
const H = 460;
const PAD = 40;

interface HoverInfo { visitorKey: string; excerpt: string; segmentId: string | null; cx: number; cy: number }

/** Multi-dimensional visitor map: pick a research dimension and the dots
 * glide to that dimension's positions, recolored by its segments. */
export function ClusterMap({ dims, sessionsBasePath }: {
  dims: DimensionData[];
  sessionsBasePath: string;
}) {
  const router = useRouter();
  const [dimKey, setDimKey] = useState(dims[0]?.dimension ?? 'overall');
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focusSegment, setFocusSegment] = useState<string | null>(null);

  const dim = dims.find((d) => d.dimension === dimKey) ?? dims[0];

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    dim?.segments.forEach((s, i) => m.set(s.id, SEGMENT_PALETTE[i % SEGMENT_PALETTE.length]));
    return (segmentId: string | null) => (segmentId && m.get(segmentId)) || '#9ca3af';
  }, [dim]);

  // Keyed by visitorKey so React reuses the node across dimension
  // switches and the CSS transition animates the move. Visitors missing
  // from the selected dimension fade out in place.
  const placed = useMemo(() => {
    const byKey = new Map<string, { cx: number; cy: number; segmentId: string | null; excerpt: string }>();
    dim?.points.forEach((p) => {
      byKey.set(p.visitorKey, {
        cx: PAD + ((p.x + 1) / 2) * (W - PAD * 2),
        cy: PAD + (1 - (p.y + 1) / 2) * (H - PAD * 2),
        segmentId: p.segmentId,
        excerpt: p.excerpt,
      });
    });
    const allKeys = new Set<string>();
    dims.forEach((d) => d.points.forEach((p) => allKeys.add(p.visitorKey)));
    return [...allKeys].map((key) => ({ key, pt: byKey.get(key) ?? null }));
  }, [dims, dim]);

  if (!dim) return null;

  return (
    <div className="space-y-3">
      {/* dimension switcher */}
      <div className="flex flex-wrap gap-1.5">
        {dims.map((d) => (
          <button
            key={d.dimension}
            type="button"
            onClick={() => { setDimKey(d.dimension); setFocusSegment(null); setHover(null); }}
            className={`rounded-full px-3.5 py-1 text-sm font-medium border transition-colors ${
              d.dimension === dim.dimension
                ? 'bg-foreground text-background border-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {DIMENSION_LABELS[d.dimension] ?? d.dimension}
          </button>
        ))}
      </div>

      {/* batch-level analyst read for this dimension */}
      {dim.analysis && (
        <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            {DIMENSION_LABELS[dim.dimension]} · analyst read
          </div>
          <p className="text-sm leading-relaxed m-0">{dim.analysis}</p>
        </div>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
             aria-label={`Visitors positioned by ${dim.dimension} similarity, colored by segment`}>
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f} className="stroke-border" strokeWidth="1" opacity="0.6">
              <line x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} strokeDasharray="2 6" />
              <line y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} strokeDasharray="2 6" />
            </g>
          ))}
          {placed.map(({ key, pt }) => {
            if (!pt) return null;
            const dimmed = focusSegment !== null && pt.segmentId !== focusSegment;
            const c = colorOf(pt.segmentId);
            return (
              <g
                key={key}
                style={{ transform: `translate(${pt.cx}px, ${pt.cy}px)`, transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1)' }}
              >
                <circle r={11} fill={c} opacity={dimmed ? 0.03 : 0.14} style={{ transition: 'fill 400ms, opacity 250ms' }} />
                <circle
                  r={5.5}
                  fill={c} opacity={dimmed ? 0.15 : 0.92}
                  stroke="white" strokeWidth="1.25"
                  style={{ cursor: 'pointer', transition: 'fill 400ms, opacity 250ms' }}
                  onMouseEnter={() => setHover({ visitorKey: key, excerpt: pt.excerpt, segmentId: pt.segmentId, cx: pt.cx, cy: pt.cy })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => router.push(`${sessionsBasePath}?user=${encodeURIComponent(key)}&range=all`)}
                />
              </g>
            );
          })}
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 max-w-64 rounded-md border bg-card p-2.5 shadow-md text-xs"
            style={{ left: `${(hover.cx / W) * 100}%`, top: `${(hover.cy / H) * 100}%`, transform: 'translate(-50%, calc(-100% - 12px))' }}
          >
            <div className="font-medium mb-0.5 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colorOf(hover.segmentId) }} />
              {hover.visitorKey.startsWith('anon-') ? `Anonymous ${hover.visitorKey.slice(5, 13)}` : hover.visitorKey}
            </div>
            <p className="text-muted-foreground m-0 leading-snug">{hover.excerpt}…</p>
          </div>
        )}
      </div>

      {/* segments of the selected dimension — hover to spotlight */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {dim.segments.map((s: Segment, i: number) => (
          <button
            key={s.id}
            type="button"
            onMouseEnter={() => setFocusSegment(s.id)}
            onMouseLeave={() => setFocusSegment(null)}
            className="text-left rounded-md border p-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length] }} />
              {s.name}
              <span className="text-muted-foreground font-normal ml-auto tabular-nums">{s.size}</span>
            </div>
            {s.description && <p className="text-xs text-muted-foreground m-0 mt-1">{s.description}</p>}
            {s.analysis && <p className="text-xs m-0 mt-1.5 leading-relaxed">{s.analysis}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}
