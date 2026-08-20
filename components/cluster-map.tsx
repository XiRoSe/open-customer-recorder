'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClusterPoint, Segment } from '@/lib/user-segments';

export const SEGMENT_PALETTE = [
  '#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4', '#84cc16', '#d946ef',
];

const W = 760;
const H = 480;
const PAD = 40;

interface Hover { point: ClusterPoint; cx: number; cy: number }

/** Animated 2D map of visitor-profile embeddings (PCA projection), one
 * dot per visitor, colored by segment. Hover a dot for the profile,
 * click to open that visitor's sessions. */
export function ClusterMap({ points, segments, sessionsBasePath }: {
  points: ClusterPoint[];
  segments: Segment[];
  sessionsBasePath: string;
}) {
  const router = useRouter();
  const [hover, setHover] = useState<Hover | null>(null);
  const [focusSegment, setFocusSegment] = useState<string | null>(null);

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    segments.forEach((s, i) => m.set(s.id, SEGMENT_PALETTE[i % SEGMENT_PALETTE.length]));
    return (segmentId: string | null) => (segmentId && m.get(segmentId)) || '#9ca3af';
  }, [segments]);

  const placed = useMemo(() => points.map((p, i) => ({
    ...p,
    cx: PAD + ((p.x + 1) / 2) * (W - PAD * 2),
    cy: PAD + ((1 - (p.y + 1) / 2)) * (H - PAD * 2),
    delay: (i % 40) * 22,
  })), [points]);

  return (
    <div className="relative">
      <style>{`
        @keyframes dot-pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .cluster-dot { animation: dot-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards; transform-box: fill-box; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) { .cluster-dot { animation: none; } }
      `}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
           aria-label="Map of visitors positioned by profile similarity, colored by segment">
        {/* soft grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} className="stroke-border" strokeWidth="1" opacity="0.6">
            <line x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} strokeDasharray="2 6" />
            <line y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} strokeDasharray="2 6" />
          </g>
        ))}
        {placed.map((p, i) => {
          const dimmed = focusSegment !== null && p.segmentId !== focusSegment;
          const c = colorOf(p.segmentId);
          return (
            <g key={`${p.visitorKey}-${i}`} className="cluster-dot" style={{ animationDelay: `${p.delay}ms` }}>
              {/* halo */}
              <circle cx={p.cx} cy={p.cy} r={11} fill={c} opacity={dimmed ? 0.03 : 0.14} />
              <circle
                cx={p.cx} cy={p.cy} r={5.5}
                fill={c} opacity={dimmed ? 0.15 : 0.92}
                stroke="white" strokeWidth="1.25"
                style={{ cursor: 'pointer', transition: 'opacity 200ms' }}
                onMouseEnter={() => setHover({ point: p, cx: p.cx, cy: p.cy })}
                onMouseLeave={() => setHover(null)}
                onClick={() => router.push(`${sessionsBasePath}?user=${encodeURIComponent(p.visitorKey)}&range=all`)}
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
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colorOf(hover.point.segmentId) }} />
            {hover.point.visitorKey.startsWith('anon-') ? `Anonymous ${hover.point.visitorKey.slice(5, 13)}` : hover.point.visitorKey}
          </div>
          <p className="text-muted-foreground m-0 leading-snug">{hover.point.excerpt}…</p>
        </div>
      )}

      {/* legend — hover to spotlight a segment */}
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {segments.map((s, i) => (
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
          </button>
        ))}
      </div>
    </div>
  );
}
