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

// Short, high-level key shown top-left; the full sentence rides each
// chip's hover title.
const DIMENSION_KEY: Record<string, string> = {
  overall: 'everything combined',
  persona: 'who they are',
  intent: 'what they want',
  source: 'where they came from',
  experience: 'how it went for them',
};

const DIMENSION_GLOSSARY: Record<string, string> = {
  overall: 'Everything combined — positioned at the average of the four dimension points. One dot = one visitor; closer = more similar; hover for the analysis, click for their sessions.',
  persona: 'Who the visitor appears to be: role, sophistication, context.',
  intent: 'What they are trying to achieve across their visits.',
  source: 'Where they came from and why: referrers, entry pages, campaigns.',
  experience: 'How it went for them: friction hit, engagement growing or fading.',
};

const W = 760;
const H = 460;
const PAD = 40;
// Muted brass for the instrument lines — the "clean steampunk" accent.
const BRASS = '#B08D57';

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
      {/* dimension switcher — each chip explains itself on hover */}
      <div className="flex flex-wrap gap-1.5 justify-end">
        {dims.map((d) => (
          <button
            key={d.dimension}
            type="button"
            title={DIMENSION_GLOSSARY[d.dimension]}
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
        <style>{`
          @keyframes dot-pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
          .cluster-dot-pop { animation: dot-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards; transform-box: fill-box; transform-origin: center; }
          @media (prefers-reduced-motion: reduce) {
            .cluster-dot-pop { animation: none; }
            .cluster-dot-move { transition: none !important; }
          }
        `}</style>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
             aria-label={`Visitors positioned by ${dim.dimension} similarity, colored by segment`}>
          {/* clean white ground, denser and more visible grid */}
          {[0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((f) => (
            <g key={f} className="stroke-border" strokeWidth="1" opacity="0.9">
              <line x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} strokeDasharray="3 5" />
              <line y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} strokeDasharray="3 5" />
            </g>
          ))}

          {/* instrument edge ticks — brass, no circles/crosshair */}
          <g stroke={BRASS} fill="none">
            {Array.from({ length: 17 }, (_, i) => PAD + (i / 16) * (W - PAD * 2)).map((x, i) => (
              <g key={`t${i}`} strokeWidth="1" opacity={i % 4 === 0 ? 0.55 : 0.3}>
                <line x1={x} x2={x} y1={H - PAD} y2={H - PAD + (i % 4 === 0 ? 8 : 5)} />
                <line x1={x} x2={x} y1={PAD} y2={PAD - (i % 4 === 0 ? 8 : 5)} />
              </g>
            ))}
          </g>

          {placed.map(({ key, pt }, i) => {
            if (!pt) return null;
            const dimmed = focusSegment !== null && pt.segmentId !== focusSegment;
            const c = colorOf(pt.segmentId);
            return (
              // Outer group glides on dimension switch; inner group pops
              // on first mount (keyed by visitor, so switching dimensions
              // never re-triggers the entrance).
              <g
                key={key}
                className="cluster-dot-move"
                style={{ transform: `translate(${pt.cx}px, ${pt.cy}px)`, transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1)' }}
              >
                <g className="cluster-dot-pop" style={{ animationDelay: `${(i % 40) * 22}ms` }}>
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
