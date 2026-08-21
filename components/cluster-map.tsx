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

  // Soft color washes under each segment's mass — centroid of its dots,
  // in plot pixels. They glide with the dots on dimension switch.
  const auras = useMemo(() => {
    if (!dim) return [];
    const bySeg = new Map<string, { sx: number; sy: number; n: number }>();
    dim.points.forEach((p) => {
      if (!p.segmentId) return;
      const cur = bySeg.get(p.segmentId) ?? { sx: 0, sy: 0, n: 0 };
      cur.sx += PAD + ((p.x + 1) / 2) * (W - PAD * 2);
      cur.sy += PAD + (1 - (p.y + 1) / 2) * (H - PAD * 2);
      cur.n += 1;
      bySeg.set(p.segmentId, cur);
    });
    return dim.segments.map((s, i) => {
      const c = bySeg.get(s.id);
      return c && c.n > 0
        ? { id: s.id, cx: c.sx / c.n, cy: c.sy / c.n, color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length], r: 70 + Math.min(60, c.n * 6) }
        : null;
    }).filter((a): a is NonNullable<typeof a> => a !== null);
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
      {/* header: high-level dimension key (left) · dimension switcher (right) */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="text-xs text-muted-foreground max-w-md">
          <div className="text-[11px] font-medium uppercase tracking-wider mb-1">Research dimensions</div>
          <p className="m-0 leading-relaxed">
            {dims.map((d, i) => (
              <span key={d.dimension}>
                {i > 0 && <span className="mx-1.5 opacity-60">·</span>}
                <span className="font-medium text-foreground/80">{DIMENSION_LABELS[d.dimension]}</span>
                {' '}{DIMENSION_KEY[d.dimension]}
              </span>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
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
          <defs>
            {SEGMENT_PALETTE.map((c, i) => (
              <radialGradient key={i} id={`aura-${i}`}>
                <stop offset="0%" stopColor={c} stopOpacity="0.16" />
                <stop offset="60%" stopColor={c} stopOpacity="0.07" />
                <stop offset="100%" stopColor={c} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>

          {/* framed plot area with a whisper of fill */}
          <rect x={PAD - 18} y={PAD - 18} width={W - (PAD - 18) * 2} height={H - (PAD - 18) * 2}
                rx="14" fill="currentColor" opacity="0.03" />
          <rect x={PAD - 18} y={PAD - 18} width={W - (PAD - 18) * 2} height={H - (PAD - 18) * 2}
                rx="14" fill="none" className="stroke-border" strokeWidth="1" />

          {/* two-level grid: fine minor + clearer quarter lines */}
          {[0.125, 0.375, 0.625, 0.875].map((f) => (
            <g key={`m${f}`} className="stroke-border" strokeWidth="0.75" opacity="0.35">
              <line x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} strokeDasharray="1 7" />
              <line y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} strokeDasharray="1 7" />
            </g>
          ))}
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f} className="stroke-border" strokeWidth="1" opacity="0.8">
              <line x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} strokeDasharray="2 6" />
              <line y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} strokeDasharray="2 6" />
            </g>
          ))}

          {/* segment auras — soft nebulae under each cluster's mass */}
          {auras.map((a) => {
            const paletteIdx = dim.segments.findIndex((s) => s.id === a.id) % SEGMENT_PALETTE.length;
            const dimmedAura = focusSegment !== null && a.id !== focusSegment;
            return (
              <circle
                key={a.id}
                r={a.r}
                fill={`url(#aura-${paletteIdx})`}
                opacity={dimmedAura ? 0.15 : 1}
                style={{ transform: `translate(${a.cx}px, ${a.cy}px)`, transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms' }}
                className="cluster-dot-move"
              />
            );
          })}
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
